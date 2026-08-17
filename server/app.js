import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import bcrypt from "bcryptjs";
import { db, ensureTeacher, nowIso, audit, projectRoot } from "./db.js";
import { parseExercisePackage } from "./exercise-package.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(projectRoot, "public");
const cookieName = "physics_practice_session";
const sessionDays = Math.max(1, Number(process.env.SESSION_DAYS || 7));
const cookieSecure = process.env.COOKIE_SECURE === "true";
const loginAttempts = new Map();
const databasePath =
  process.env.DATABASE_PATH || path.join(projectRoot, "database", "practice.db");
const exerciseStorageRoot =
  process.env.EXERCISE_STORAGE_DIR ||
  path.join(path.dirname(databasePath), "exercise-content");
const exerciseAssetsRoot = path.join(exerciseStorageRoot, "assets");
const exercisePackagesRoot = path.join(exerciseStorageRoot, "packages");

fs.mkdirSync(exerciseAssetsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(exercisePackagesRoot, { recursive: true, mode: 0o700 });

ensureTeacher(
  process.env.BOOTSTRAP_TEACHER_USERNAME,
  process.env.BOOTSTRAP_TEACHER_PASSWORD,
);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
  bodyLimit: 12 * 1024 * 1024,
  trustProxy: process.env.TRUST_PROXY === "true",
});

await app.register(fastifyCookie);
app.addContentTypeParser(
  ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
  { parseAs: "buffer", bodyLimit: 10 * 1024 * 1024 },
  (_request, body, done) => done(null, body),
);
await app.register(fastifyStatic, {
  root: publicRoot,
  prefix: "/",
  wildcard: false,
});
await app.register(fastifyStatic, {
  root: path.join(projectRoot, "node_modules", "katex", "dist"),
  prefix: "/vendor/katex/",
  decorateReply: false,
  wildcard: false,
});
await app.register(fastifyStatic, {
  root: exerciseAssetsRoot,
  prefix: "/exercise-assets/",
  decorateReply: false,
  wildcard: false,
});

app.addHook("onRequest", async (request, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "same-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'self'; frame-ancestors 'none'",
  );

  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== request.headers.host) {
          return reply.code(403).send({ error: "请求来源无效。" });
        }
      } catch {
        return reply.code(403).send({ error: "请求来源无效。" });
      }
    }
  }
});

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    note: user.note,
    mustChangePassword: Boolean(user.must_change_password),
  };
}

function getSessionUser(request) {
  const token = request.cookies[cookieName];
  if (!token) return null;
  return (
    db
      .prepare(`
        SELECT u.*
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
      `)
      .get(hashToken(token), nowIso()) ?? null
  );
}

async function requireAuth(request, reply) {
  const user = getSessionUser(request);
  if (!user) return reply.code(401).send({ error: "请先登录。" });
  request.user = user;
}

async function requireTeacher(request, reply) {
  const result = await requireAuth(request, reply);
  if (reply.sent) return result;
  if (request.user.role !== "teacher") {
    return reply.code(403).send({ error: "需要教师权限。" });
  }
}

async function requireStudent(request, reply) {
  const result = await requireAuth(request, reply);
  if (reply.sent) return result;
  if (request.user.role !== "student") {
    return reply.code(403).send({ error: "需要学生账号。" });
  }
}

function validateStudentUsername(value) {
  const username = String(value ?? "").trim();
  if (username.length < 3 || username.length > 24) {
    return { error: "用户名长度应为 3～24 个字符。" };
  }
  if (!/^[\p{L}\p{N}_]+$/u.test(username)) {
    return { error: "用户名只能包含中文、字母、数字和下划线。" };
  }
  if (["admin", "teacher", "system", "root"].includes(username.toLowerCase())) {
    return { error: "该用户名为系统保留名称。" };
  }
  return { username };
}

function validatePassword(value) {
  const password = String(value ?? "");
  if (password.length < 6 || password.length > 128) {
    return { error: "密码长度应为 6～128 个字符。" };
  }
  return { password };
}

function setSession(reply, userId) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + sessionDays * 86400_000);
  db.prepare(`
    INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(userId, hashToken(token), expiresAt.toISOString(), nowIso());
  reply.setCookie(cookieName, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure,
    maxAge: sessionDays * 86400,
  });
}

function getAssignedExerciseBySlug(slug, userId) {
  return db
    .prepare(`
      SELECT e.*
      FROM exercises e
      JOIN exercise_assignments assignment
        ON assignment.exercise_id = e.id AND assignment.user_id = ?
      WHERE e.slug = ? AND e.visible = 1
    `)
    .get(userId, slug);
}

function getOrCreateAttempt(userId, exerciseId) {
  let attempt = db
    .prepare("SELECT * FROM attempts WHERE user_id = ? AND exercise_id = ?")
    .get(userId, exerciseId);
  if (!attempt) {
    const timestamp = nowIso();
    const result = db
      .prepare(`
        INSERT INTO attempts (user_id, exercise_id, status, created_at, updated_at)
        VALUES (?, ?, 'draft', ?, ?)
      `)
      .run(userId, exerciseId, timestamp, timestamp);
    attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(result.lastInsertRowid);
  }
  return attempt;
}

function statusLabel(status) {
  return {
    draft: "可继续作答",
    grading: "批改中，答案已锁定",
    published: "成绩已发布",
  }[status];
}

function parseNumericAnswer(value) {
  const normalized = String(value ?? "")
    .trim()
    .replaceAll("×", "*")
    .replace(/\s+/g, "");
  const match = normalized.match(
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\*10\^([+-]?\d+))?$/,
  );
  if (!match) return null;
  const mantissa = match[1];
  const exponent = Number(match[2] ?? 0);
  const numericValue = Number(mantissa) * 10 ** exponent;
  if (!Number.isFinite(numericValue)) return null;
  return {
    value: numericValue,
    decimals: (mantissa.replace(/^[+-]/, "").split(".")[1] ?? "").length,
  };
}

function normalizeTextAnswer(value, caseSensitive = true) {
  const normalized = String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("de");
}

function parseTextResponse(value, blankCount) {
  let parsed;
  try {
    parsed = JSON.parse(String(value ?? ""));
  } catch {
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== blankCount ||
    parsed.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 200)
  ) {
    return null;
  }
  return parsed.map((entry) => entry.trim());
}

function textResponseIsCorrect(value, answerJson, caseSensitive) {
  let accepted;
  try {
    accepted = JSON.parse(answerJson);
  } catch {
    return false;
  }
  if (!Array.isArray(accepted)) return false;
  const response = parseTextResponse(value, accepted.length);
  if (!response) return false;
  return response.every((entry, index) => {
    const alternatives = Array.isArray(accepted[index]) ? accepted[index] : [];
    const normalizedEntry = normalizeTextAnswer(entry, caseSensitive);
    return alternatives.some(
      (answer) => normalizeTextAnswer(answer, caseSensitive) === normalizedEntry,
    );
  });
}

function removeImportedExerciseFiles(slug) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return;
  fs.rmSync(path.join(exerciseAssetsRoot, slug), { recursive: true, force: true });
  fs.rmSync(path.join(exercisePackagesRoot, `${slug}.zip`), { force: true });
}

function storeImportedExerciseFiles(slug, rawPackage, assets) {
  removeImportedExerciseFiles(slug);
  const assetDirectory = path.join(exerciseAssetsRoot, slug);
  fs.mkdirSync(assetDirectory, { recursive: true, mode: 0o700 });
  for (const asset of assets) {
    const destination = path.resolve(assetDirectory, asset.name);
    const relative = path.relative(assetDirectory, destination);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("素材文件路径无效。");
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, asset.data, { mode: 0o600 });
  }
  fs.writeFileSync(path.join(exercisePackagesRoot, `${slug}.zip`), rawPackage, {
    mode: 0o600,
  });
}

app.get("/api/health", async () => ({ ok: true, time: nowIso() }));

app.post("/api/auth/login", async (request, reply) => {
  const username = String(request.body?.username ?? "").trim();
  const password = String(request.body?.password ?? "");
  const attemptKey = `${request.ip}:${username.toLowerCase()}`;
  const attemptState = loginAttempts.get(attemptKey);
  if (attemptState?.blockedUntil > Date.now()) {
    return reply.code(429).send({ error: "尝试次数过多，请稍后再试。" });
  }

  const user = db
    .prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1")
    .get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    const failures = (attemptState?.failures ?? 0) + 1;
    loginAttempts.set(attemptKey, {
      failures,
      blockedUntil: failures >= 5 ? Date.now() + 5 * 60_000 : 0,
    });
    return reply.code(401).send({ error: "用户名或密码不正确。" });
  }

  loginAttempts.delete(attemptKey);
  setSession(reply, user.id);
  audit(user.id, "login", "user", user.id);
  return { user: publicUser(user) };
});

app.post("/api/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
  const token = request.cookies[cookieName];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  reply.clearCookie(cookieName, { path: "/" });
  return { ok: true };
});

app.get("/api/me", { preHandler: requireAuth }, async (request) => ({
  user: publicUser(request.user),
}));

app.post("/api/activate", async (request, reply) => {
  const token = String(request.body?.token ?? "").trim().toUpperCase();
  const usernameResult = validateStudentUsername(request.body?.username);
  if (usernameResult.error) return reply.code(400).send({ error: usernameResult.error });
  const passwordResult = validatePassword(request.body?.password);
  if (passwordResult.error) return reply.code(400).send({ error: passwordResult.error });

  const tokenRow = db
    .prepare(`
      SELECT * FROM activation_tokens
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
    `)
    .get(hashToken(token), nowIso());
  if (!tokenRow) return reply.code(400).send({ error: "激活码无效或已过期。" });

  const timestamp = nowIso();
  try {
    const transaction = db.transaction(() => {
      const result = db
        .prepare(`
          INSERT INTO users
            (username, password_hash, role, note, active, must_change_password, created_at, updated_at)
          VALUES (?, ?, 'student', ?, 1, 0, ?, ?)
        `)
        .run(
          usernameResult.username,
          bcrypt.hashSync(passwordResult.password, 12),
          tokenRow.note,
          timestamp,
          timestamp,
        );
      db.prepare("UPDATE activation_tokens SET used_at = ? WHERE id = ?").run(timestamp, tokenRow.id);
      return Number(result.lastInsertRowid);
    });
    const userId = transaction();
    setSession(reply, userId);
    audit(userId, "activate_account", "user", userId);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    return { user: publicUser(user) };
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return reply.code(409).send({ error: "这个用户名已经被使用，请换一个。" });
    }
    throw error;
  }
});

app.post("/api/auth/change-password", { preHandler: requireAuth }, async (request, reply) => {
  const current = String(request.body?.currentPassword ?? "");
  const nextResult = validatePassword(request.body?.newPassword);
  if (nextResult.error) return reply.code(400).send({ error: nextResult.error });
  if (!bcrypt.compareSync(current, request.user.password_hash)) {
    return reply.code(400).send({ error: "当前密码不正确。" });
  }
  db.prepare(`
    UPDATE users
    SET password_hash = ?, must_change_password = 0, updated_at = ?
    WHERE id = ?
  `).run(bcrypt.hashSync(nextResult.password, 12), nowIso(), request.user.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(request.user.id);
  reply.clearCookie(cookieName, { path: "/" });
  audit(request.user.id, "change_password", "user", request.user.id);
  return { ok: true };
});

app.get("/api/exercises", { preHandler: requireAuth }, async (request) => {
  if (request.user.role === "teacher") {
    const exercises = db
      .prepare(`
        SELECT id, slug, code, title, subtitle, page, total_points, question_count
        FROM exercises WHERE visible = 1 ORDER BY id
      `)
      .all();
    return { exercises };
  }
  const exercises = db
    .prepare(`
      SELECT
        e.id, e.slug, e.code, e.title, e.subtitle, e.page, e.total_points, e.question_count,
        a.id AS attempt_id, a.status, a.total_score, a.max_score,
        COUNT(r.id) AS answered_count
      FROM exercises e
      JOIN exercise_assignments assignment
        ON assignment.exercise_id = e.id AND assignment.user_id = ?
      LEFT JOIN attempts a ON a.exercise_id = e.id AND a.user_id = ?
      LEFT JOIN responses r ON r.attempt_id = a.id AND TRIM(r.answer_text) <> ''
      WHERE e.visible = 1
      GROUP BY e.id, a.id
      ORDER BY e.id
    `)
    .all(request.user.id, request.user.id)
    .map((exercise) => ({
      ...exercise,
      status: exercise.status ?? "not_started",
      statusLabel:
        exercise.status === "published"
          ? "已发布成绩"
          : exercise.status === "grading"
            ? "批改中"
            : Number(exercise.answered_count) > 0
              ? "可继续作答"
              : "未开始",
    }));
  return { exercises };
});

app.get(
  "/api/teacher/exercise-management",
  { preHandler: requireTeacher },
  async () => {
    const exercises = db
      .prepare(`
        SELECT
          e.id, e.slug, e.code, e.title, e.subtitle, e.page,
          e.total_points, e.question_count, e.visible, e.source_type,
          e.created_at, e.updated_at,
          (SELECT COUNT(*) FROM attempts a WHERE a.exercise_id = e.id) AS attempt_count,
          (
            SELECT COUNT(*)
            FROM responses r
            JOIN attempts a ON a.id = r.attempt_id
            WHERE a.exercise_id = e.id
          ) AS response_count,
          (
            SELECT COUNT(*)
            FROM grading_items g
            JOIN attempts a ON a.id = g.attempt_id
            WHERE a.exercise_id = e.id
          ) AS grading_count
        FROM exercises e
        ORDER BY e.id
      `)
      .all()
      .map((exercise) => ({
        ...exercise,
        visible: Boolean(exercise.visible),
      }));
    return { exercises };
  },
);

app.post(
  "/api/teacher/exercises/import",
  { preHandler: requireTeacher },
  async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) {
      return reply.code(400).send({ error: "请上传 ZIP 练习包。" });
    }
    const parsed = parseExercisePackage(request.body);
    const { exercise } = parsed;
    const existing = db.prepare("SELECT id FROM exercises WHERE slug = ?").get(exercise.slug);
    if (existing) {
      return reply.code(409).send({
        error: `slug=${exercise.slug} 已存在。请更换 slug，或先永久删除原练习。`,
      });
    }

    const timestamp = nowIso();
    const insertTransaction = db.transaction(() => {
      const result = db
        .prepare(`
          INSERT INTO exercises
            (
              slug, code, title, subtitle, page, total_points, question_count,
              visible, source_type, created_at, updated_at
            )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)
        `)
        .run(
          exercise.slug,
          exercise.code,
          exercise.title,
          exercise.subtitle,
          exercise.page,
          exercise.totalPoints,
          exercise.questionCount,
          exercise.visible,
          timestamp,
          timestamp,
        );
      const exerciseId = Number(result.lastInsertRowid);
      const insertQuestion = db.prepare(`
        INSERT INTO questions
          (
            id, exercise_id, label, parent_number, title, type, input_mode,
            max_points, prompt_html, options_json, sort_order
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertAnswer = db.prepare(`
        INSERT INTO answer_keys
          (
            question_id, correct_value, answer_html, numeric_value,
            numeric_tolerance, required_decimals, unit_label,
            text_answers_json, text_case_sensitive
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const question of exercise.questions) {
        insertQuestion.run(
          question.id,
          exerciseId,
          question.label,
          question.parentNumber,
          question.title,
          question.type,
          question.inputMode === "text" ? "manual" : question.inputMode,
          question.maxPoints,
          question.promptHtml,
          JSON.stringify(question.options),
          question.sortOrder,
        );
        insertAnswer.run(
          question.id,
          question.correctValue,
          question.answerHtml,
          question.numericValue,
          question.numericTolerance,
          question.requiredDecimals,
          question.unitLabel,
          question.textAnswers ? JSON.stringify(question.textAnswers) : null,
          question.textCaseSensitive === false ? 0 : 1,
        );
      }
      return exerciseId;
    });

    let exerciseId;
    try {
      exerciseId = insertTransaction();
      storeImportedExerciseFiles(exercise.slug, request.body, parsed.assets);
    } catch (error) {
      if (exerciseId) db.prepare("DELETE FROM exercises WHERE id = ?").run(exerciseId);
      removeImportedExerciseFiles(exercise.slug);
      throw error;
    }

    const modes = Object.fromEntries(
      ["mcq", "numeric", "text", "manual"].map((mode) => [
        mode,
        exercise.questions.filter((question) => question.inputMode === mode).length,
      ]),
    );
    audit(request.user.id, "import_exercise", "exercise", exercise.slug, {
      exerciseId,
      questionCount: exercise.questionCount,
      totalPoints: exercise.totalPoints,
      modes,
      published: Boolean(exercise.visible),
    });
    return reply.code(201).send({
      exercise: {
        id: exerciseId,
        slug: exercise.slug,
        code: exercise.code,
        title: exercise.title,
        totalPoints: exercise.totalPoints,
        questionCount: exercise.questionCount,
        visible: Boolean(exercise.visible),
        modes,
      },
    });
  },
);

app.patch(
  "/api/teacher/exercises/:id/visibility",
  { preHandler: requireTeacher },
  async (request, reply) => {
    const exercise = db.prepare("SELECT * FROM exercises WHERE id = ?").get(request.params.id);
    if (!exercise) return reply.code(404).send({ error: "找不到练习。" });
    if (typeof request.body?.visible !== "boolean") {
      return reply.code(400).send({ error: "visible 必须是布尔值。" });
    }
    const visible = request.body.visible ? 1 : 0;
    db.prepare("UPDATE exercises SET visible = ?, updated_at = ? WHERE id = ?").run(
      visible,
      nowIso(),
      exercise.id,
    );
    audit(request.user.id, visible ? "publish_exercise" : "unpublish_exercise", "exercise", exercise.slug);
    return { ok: true, visible: Boolean(visible) };
  },
);

app.delete(
  "/api/teacher/exercises/:id",
  { preHandler: requireTeacher },
  async (request, reply) => {
    const exercise = db.prepare("SELECT * FROM exercises WHERE id = ?").get(request.params.id);
    if (!exercise) return reply.code(404).send({ error: "找不到练习。" });
    if (String(request.body?.confirmation ?? "") !== exercise.slug) {
      return reply.code(400).send({ error: "确认文字与练习 slug 不一致。" });
    }

    const counts = {
      questions: db
        .prepare("SELECT COUNT(*) AS count FROM questions WHERE exercise_id = ?")
        .get(exercise.id).count,
      attempts: db
        .prepare("SELECT COUNT(*) AS count FROM attempts WHERE exercise_id = ?")
        .get(exercise.id).count,
      responses: db
        .prepare(`
          SELECT COUNT(*) AS count
          FROM responses r JOIN attempts a ON a.id = r.attempt_id
          WHERE a.exercise_id = ?
        `)
        .get(exercise.id).count,
      grades: db
        .prepare(`
          SELECT COUNT(*) AS count
          FROM grading_items g JOIN attempts a ON a.id = g.attempt_id
          WHERE a.exercise_id = ?
        `)
        .get(exercise.id).count,
    };

    const backupDirectory =
      process.env.BACKUP_DIR || path.join(path.dirname(databasePath), "backups");
    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const backupBase = `practice-before-delete-${exercise.slug}-${Date.now()}.sqlite`;
    const uncompressedBackup = path.join(backupDirectory, backupBase);
    const backupName = `${backupBase}.gz`;
    await db.backup(uncompressedBackup);
    fs.writeFileSync(
      path.join(backupDirectory, backupName),
      zlib.gzipSync(fs.readFileSync(uncompressedBackup), { level: 9 }),
      { mode: 0o600 },
    );
    fs.rmSync(uncompressedBackup, { force: true });

    const deleteTransaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO deleted_exercises (slug, deleted_at, deleted_by)
        VALUES (?, ?, ?)
        ON CONFLICT(slug) DO UPDATE SET
          deleted_at = excluded.deleted_at,
          deleted_by = excluded.deleted_by
      `).run(exercise.slug, nowIso(), request.user.id);
      db.prepare("DELETE FROM exercises WHERE id = ?").run(exercise.id);
      audit(request.user.id, "permanently_delete_exercise", "exercise", exercise.slug, counts);
    });
    deleteTransaction();
    removeImportedExerciseFiles(exercise.slug);

    return {
      ok: true,
      deleted: exercise.slug,
      counts,
      backup: backupName,
    };
  },
);

app.get("/api/exercises/:slug", { preHandler: requireStudent }, async (request, reply) => {
  const exercise = getAssignedExerciseBySlug(request.params.slug, request.user.id);
  if (!exercise) return reply.code(404).send({ error: "找不到练习，或教师尚未分配该作业。" });
  const attempt = getOrCreateAttempt(request.user.id, exercise.id);
  const questions = db
    .prepare(`
      SELECT
        q.id, q.label, q.parent_number, q.title, q.type, q.input_mode,
        q.max_points, q.prompt_html, q.options_json, q.sort_order,
        a.required_decimals, a.unit_label, a.text_answers_json
      FROM questions q
      JOIN answer_keys a ON a.question_id = q.id
      WHERE q.exercise_id = ? ORDER BY q.sort_order
    `)
    .all(exercise.id)
    .map((question) => {
      let blankCount = null;
      if (question.text_answers_json) {
        try {
          blankCount = JSON.parse(question.text_answers_json).length;
        } catch {
          blankCount = null;
        }
      }
      return {
        ...question,
        input_mode: blankCount ? "text" : question.input_mode,
        blank_count: blankCount,
        options: JSON.parse(question.options_json),
        options_json: undefined,
        text_answers_json: undefined,
      };
    });
  const responseRows = db
    .prepare("SELECT question_id, answer_text, updated_at FROM responses WHERE attempt_id = ?")
    .all(attempt.id);
  const responses = Object.fromEntries(
    responseRows.map((response) => [
      response.question_id,
      { answer: response.answer_text, updatedAt: response.updated_at },
    ]),
  );

  let results = {};
  if (attempt.status === "published") {
    const rows = db
      .prepare(`
        SELECT
          g.question_id, g.score, g.is_correct, g.comment,
          q.max_points, a.answer_html
        FROM grading_items g
        JOIN questions q ON q.id = g.question_id
        JOIN answer_keys a ON a.question_id = g.question_id
        WHERE g.attempt_id = ?
      `)
      .all(attempt.id);
    results = Object.fromEntries(
      rows.map((row) => [
        row.question_id,
        {
          score: row.score,
          maxPoints: row.max_points,
          isCorrect: Boolean(row.is_correct),
          comment: row.comment,
          answerHtml: row.score < row.max_points ? row.answer_html : null,
        },
      ]),
    );
  }

  return {
    exercise: {
      id: exercise.id,
      slug: exercise.slug,
      code: exercise.code,
      title: exercise.title,
      subtitle: exercise.subtitle,
      totalPoints: exercise.total_points,
      questionCount: exercise.question_count,
    },
    attempt: {
      id: attempt.id,
      status: attempt.status,
      statusLabel: statusLabel(attempt.status),
      totalScore: attempt.total_score,
      maxScore: attempt.max_score,
      overallComment: attempt.status === "published" ? attempt.overall_comment : "",
    },
    questions,
    responses,
    results,
  };
});

app.put(
  "/api/exercises/:slug/responses/:questionId",
  { preHandler: requireStudent },
  async (request, reply) => {
    const exercise = getAssignedExerciseBySlug(request.params.slug, request.user.id);
    if (!exercise) return reply.code(404).send({ error: "找不到练习，或教师尚未分配该作业。" });
    const attempt = getOrCreateAttempt(request.user.id, exercise.id);
    if (attempt.status !== "draft") {
      return reply.code(409).send({ error: "教师已经开始批改，答案已锁定。" });
    }
    const question = db
      .prepare(`
        SELECT
          q.id, q.input_mode, a.required_decimals,
          a.text_answers_json, a.text_case_sensitive
        FROM questions q
        JOIN answer_keys a ON a.question_id = q.id
        WHERE q.id = ? AND q.exercise_id = ?
      `)
      .get(request.params.questionId, exercise.id);
    if (!question) return reply.code(404).send({ error: "找不到题目。" });
    const answer = String(request.body?.answer ?? "").trim();
    if (!answer) {
      db.prepare("DELETE FROM responses WHERE attempt_id = ? AND question_id = ?").run(
        attempt.id,
        question.id,
      );
      return { ok: true, deleted: true };
    }
    if (answer.length > 12_000) {
      return reply.code(400).send({ error: "答案过长，请适当精简。" });
    }
    if (question.input_mode === "numeric") {
      const parsed = parseNumericAnswer(answer);
      if (!parsed) {
        return reply.code(400).send({
          error: "请只填写数值。科学计数法请写成 1.1*10^2，不要填写单位。",
        });
      }
      if (parsed.decimals !== question.required_decimals) {
        return reply.code(400).send({
          error: `这道题要求保留 ${question.required_decimals} 位小数。`,
        });
      }
    }
    if (question.text_answers_json) {
      let accepted;
      try {
        accepted = JSON.parse(question.text_answers_json);
      } catch {
        accepted = null;
      }
      const parsed = Array.isArray(accepted)
        ? parseTextResponse(answer, accepted.length)
        : null;
      if (!parsed) {
        return reply.code(400).send({
          error: "请在每个空格中只填写缺少的词或词组，不能留空。",
        });
      }
    }
    const timestamp = nowIso();
    db.prepare(`
      INSERT INTO responses (attempt_id, question_id, answer_text, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(attempt_id, question_id) DO UPDATE SET
        answer_text = excluded.answer_text,
        updated_at = excluded.updated_at
    `).run(attempt.id, question.id, answer, timestamp);
    db.prepare("UPDATE attempts SET updated_at = ? WHERE id = ?").run(timestamp, attempt.id);
    return { ok: true, updatedAt: timestamp };
  },
);

app.delete(
  "/api/exercises/:slug/responses/:questionId",
  { preHandler: requireStudent },
  async (request, reply) => {
    const exercise = getAssignedExerciseBySlug(request.params.slug, request.user.id);
    if (!exercise) return reply.code(404).send({ error: "找不到练习，或教师尚未分配该作业。" });
    const attempt = getOrCreateAttempt(request.user.id, exercise.id);
    if (attempt.status !== "draft") {
      return reply.code(409).send({ error: "教师已经开始批改，答案已锁定。" });
    }
    db.prepare("DELETE FROM responses WHERE attempt_id = ? AND question_id = ?").run(
      attempt.id,
      request.params.questionId,
    );
    return { ok: true };
  },
);

app.get("/api/teacher/users", { preHandler: requireTeacher }, async () => ({
  users: db
    .prepare(`
      SELECT
        u.id, u.username, u.note, u.active, u.must_change_password, u.created_at, u.updated_at,
        (SELECT COUNT(*) FROM exercise_assignments ea WHERE ea.user_id = u.id) AS assignment_count,
        (SELECT COUNT(*) FROM attempts a WHERE a.user_id = u.id) AS attempt_count,
        (
          SELECT COUNT(*)
          FROM responses r
          JOIN attempts a ON a.id = r.attempt_id
          WHERE a.user_id = u.id
        ) AS response_count,
        (
          SELECT COUNT(*)
          FROM grading_items g
          JOIN attempts a ON a.id = g.attempt_id
          WHERE a.user_id = u.id
        ) AS grading_count
      FROM users u
      WHERE u.role = 'student'
      ORDER BY u.username COLLATE NOCASE
    `)
    .all()
    .map((user) => ({
      ...user,
      active: Boolean(user.active),
      mustChangePassword: Boolean(user.must_change_password),
    })),
}));

app.get(
  "/api/teacher/users/:id/assignments",
  { preHandler: requireTeacher },
  async (request, reply) => {
    const student = db
      .prepare("SELECT id, username, note FROM users WHERE id = ? AND role = 'student'")
      .get(request.params.id);
    if (!student) return reply.code(404).send({ error: "找不到学生账号。" });

    const assignments = db
      .prepare(`
        SELECT
          e.id, e.slug, e.code, e.title, e.subtitle, e.visible,
          CASE WHEN ea.user_id IS NULL THEN 0 ELSE 1 END AS assigned
        FROM exercises e
        LEFT JOIN exercise_assignments ea
          ON ea.exercise_id = e.id AND ea.user_id = ?
        ORDER BY e.id
      `)
      .all(student.id)
      .map((exercise) => ({
        ...exercise,
        visible: Boolean(exercise.visible),
        assigned: Boolean(exercise.assigned),
      }));

    return { student, assignments };
  },
);

app.put(
  "/api/teacher/users/:id/assignments",
  { preHandler: requireTeacher },
  async (request, reply) => {
    const student = db
      .prepare("SELECT id, username FROM users WHERE id = ? AND role = 'student'")
      .get(request.params.id);
    if (!student) return reply.code(404).send({ error: "找不到学生账号。" });
    if (!Array.isArray(request.body?.exerciseIds)) {
      return reply.code(400).send({ error: "exerciseIds 必须是数组。" });
    }

    const exerciseIds = [
      ...new Set(
        request.body.exerciseIds
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0),
      ),
    ];
    if (exerciseIds.length !== request.body.exerciseIds.length || exerciseIds.length > 500) {
      return reply.code(400).send({ error: "作业编号无效或存在重复。" });
    }

    if (exerciseIds.length) {
      const placeholders = exerciseIds.map(() => "?").join(", ");
      const existingCount = db
        .prepare(`SELECT COUNT(*) AS count FROM exercises WHERE id IN (${placeholders})`)
        .get(...exerciseIds).count;
      if (existingCount !== exerciseIds.length) {
        return reply.code(400).send({ error: "包含不存在的作业。" });
      }
    }

    const timestamp = nowIso();
    const replaceAssignments = db.transaction(() => {
      db.prepare("DELETE FROM exercise_assignments WHERE user_id = ?").run(student.id);
      const insert = db.prepare(`
        INSERT INTO exercise_assignments (user_id, exercise_id, assigned_by, assigned_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const exerciseId of exerciseIds) {
        insert.run(student.id, exerciseId, request.user.id, timestamp);
      }
      audit(request.user.id, "replace_exercise_assignments", "user", student.id, {
        username: student.username,
        exerciseIds,
      });
    });
    replaceAssignments();

    return { ok: true, assignedCount: exerciseIds.length };
  },
);

app.post("/api/teacher/activation-tokens", { preHandler: requireTeacher }, async (request) => {
  const token = crypto.randomBytes(5).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
  const note = String(request.body?.note ?? "").trim().slice(0, 100);
  const result = db
    .prepare(`
      INSERT INTO activation_tokens (token_hash, note, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(hashToken(token), note, expiresAt, nowIso());
  audit(request.user.id, "create_activation_token", "activation_token", result.lastInsertRowid, {
    note,
    expiresAt,
  });
  return { token, expiresAt, note };
});

app.post("/api/teacher/users", { preHandler: requireTeacher }, async (request, reply) => {
  const usernameResult = validateStudentUsername(request.body?.username);
  if (usernameResult.error) return reply.code(400).send({ error: usernameResult.error });
  const passwordResult = validatePassword(request.body?.password);
  if (passwordResult.error) return reply.code(400).send({ error: passwordResult.error });
  const note = String(request.body?.note ?? "").trim().slice(0, 100);
  const timestamp = nowIso();
  try {
    const result = db
      .prepare(`
        INSERT INTO users
          (username, password_hash, role, note, active, must_change_password, created_at, updated_at)
        VALUES (?, ?, 'student', ?, 1, 1, ?, ?)
      `)
      .run(
        usernameResult.username,
        bcrypt.hashSync(passwordResult.password, 12),
        note,
        timestamp,
        timestamp,
      );
    audit(request.user.id, "create_student", "user", result.lastInsertRowid, {
      username: usernameResult.username,
    });
    return { ok: true, id: Number(result.lastInsertRowid) };
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return reply.code(409).send({ error: "用户名已经存在。" });
    }
    throw error;
  }
});

app.patch("/api/teacher/users/:id", { preHandler: requireTeacher }, async (request, reply) => {
  const user = db
    .prepare("SELECT * FROM users WHERE id = ? AND role = 'student'")
    .get(request.params.id);
  if (!user) return reply.code(404).send({ error: "找不到学生账号。" });
  const usernameResult = validateStudentUsername(request.body?.username ?? user.username);
  if (usernameResult.error) return reply.code(400).send({ error: usernameResult.error });
  const note = String(request.body?.note ?? user.note).trim().slice(0, 100);
  const active = request.body?.active === undefined ? user.active : request.body.active ? 1 : 0;
  try {
    db.prepare(`
      UPDATE users SET username = ?, note = ?, active = ?, updated_at = ? WHERE id = ?
    `).run(usernameResult.username, note, active, nowIso(), user.id);
    if (!active) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    audit(request.user.id, "update_student", "user", user.id, {
      username: usernameResult.username,
      active: Boolean(active),
    });
    return { ok: true };
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) {
      return reply.code(409).send({ error: "用户名已经存在。" });
    }
    throw error;
  }
});

app.post(
  "/api/teacher/users/:id/reset-password",
  { preHandler: requireTeacher },
  async (request, reply) => {
    const passwordResult = validatePassword(request.body?.password);
    if (passwordResult.error) return reply.code(400).send({ error: passwordResult.error });
    const user = db
      .prepare("SELECT id FROM users WHERE id = ? AND role = 'student'")
      .get(request.params.id);
    if (!user) return reply.code(404).send({ error: "找不到学生账号。" });
    db.prepare(`
      UPDATE users
      SET password_hash = ?, must_change_password = 1, updated_at = ?
      WHERE id = ?
    `).run(bcrypt.hashSync(passwordResult.password, 12), nowIso(), user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
    audit(request.user.id, "reset_student_password", "user", user.id);
    return { ok: true };
  },
);

app.post("/api/teacher/users/:id/logout", { preHandler: requireTeacher }, async (request, reply) => {
  const user = db
    .prepare("SELECT id FROM users WHERE id = ? AND role = 'student'")
    .get(request.params.id);
  if (!user) return reply.code(404).send({ error: "找不到学生账号。" });
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  audit(request.user.id, "force_logout_student", "user", user.id);
  return { ok: true };
});

app.delete("/api/teacher/users/:id", { preHandler: requireTeacher }, async (request, reply) => {
  const user = db
    .prepare("SELECT id, username FROM users WHERE id = ? AND role = 'student'")
    .get(request.params.id);
  if (!user) return reply.code(404).send({ error: "找不到学生账号。" });
  if (String(request.body?.confirmation ?? "") !== user.username) {
    return reply.code(400).send({ error: "确认文字与学生用户名不一致。" });
  }

  const counts = {
    attempts: db
      .prepare("SELECT COUNT(*) AS count FROM attempts WHERE user_id = ?")
      .get(user.id).count,
    responses: db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM responses r
        JOIN attempts a ON a.id = r.attempt_id
        WHERE a.user_id = ?
      `)
      .get(user.id).count,
    grades: db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM grading_items g
        JOIN attempts a ON a.id = g.attempt_id
        WHERE a.user_id = ?
      `)
      .get(user.id).count,
  };

  const backupDirectory =
    process.env.BACKUP_DIR || path.join(path.dirname(databasePath), "backups");
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const backupBase = `practice-before-delete-student-${user.id}-${Date.now()}.sqlite`;
  const uncompressedBackup = path.join(backupDirectory, backupBase);
  const backupName = `${backupBase}.gz`;
  await db.backup(uncompressedBackup);
  fs.writeFileSync(
    path.join(backupDirectory, backupName),
    zlib.gzipSync(fs.readFileSync(uncompressedBackup), { level: 9 }),
    { mode: 0o600 },
  );
  fs.rmSync(uncompressedBackup, { force: true });

  const deleteTransaction = db.transaction(() => {
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    audit(request.user.id, "permanently_delete_student", "user", user.id, {
      username: user.username,
      ...counts,
    });
  });
  deleteTransaction();

  return {
    ok: true,
    deleted: user.username,
    counts,
    backup: backupName,
  };
});

app.get("/api/teacher/attempts", { preHandler: requireTeacher }, async (request) => {
  const exerciseId = Number(request.query?.exerciseId);
  const attempts = db
    .prepare(`
      SELECT
        a.id, a.status, a.total_score, a.max_score, a.locked_at, a.published_at, a.updated_at,
        u.username, u.note,
        COUNT(r.id) AS answered_count,
        COALESCE(SUM(q.max_points), 0) AS answered_points
      FROM attempts a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN responses r ON r.attempt_id = a.id AND TRIM(r.answer_text) <> ''
      LEFT JOIN questions q ON q.id = r.question_id
      WHERE a.exercise_id = ?
      GROUP BY a.id
      ORDER BY
        CASE a.status WHEN 'grading' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
        a.updated_at DESC
    `)
    .all(exerciseId)
    .map((attempt) => ({
      ...attempt,
      statusLabel: statusLabel(attempt.status),
    }));
  return { attempts };
});

app.post("/api/teacher/attempts/lock", { preHandler: requireTeacher }, async (request, reply) => {
  const ids = [...new Set((request.body?.attemptIds ?? []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return reply.code(400).send({ error: "请选择至少一位学生。" });

  const lockOne = db.transaction((attemptId) => {
    const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
    if (!attempt) return { id: attemptId, ok: false, message: "找不到作答" };
    if (attempt.status !== "draft") {
      return { id: attemptId, ok: false, message: statusLabel(attempt.status) };
    }
    const responses = db
      .prepare(`
        SELECT
          r.question_id, r.answer_text, q.type, q.input_mode, q.max_points,
          a.correct_value, a.numeric_value, a.numeric_tolerance, a.required_decimals,
          a.text_answers_json, a.text_case_sensitive
        FROM responses r
        JOIN questions q ON q.id = r.question_id
        JOIN answer_keys a ON a.question_id = r.question_id
        WHERE r.attempt_id = ? AND TRIM(r.answer_text) <> ''
      `)
      .all(attemptId);
    if (!responses.length) return { id: attemptId, ok: false, message: "没有已保存答案" };
    const timestamp = nowIso();
    const maxScore = responses.reduce((sum, response) => sum + response.max_points, 0);
    db.prepare(`
      UPDATE attempts
      SET status = 'grading', max_score = ?, locked_at = ?, updated_at = ?
      WHERE id = ?
    `).run(maxScore, timestamp, timestamp, attemptId);

    const upsertGrade = db.prepare(`
      INSERT INTO grading_items
        (attempt_id, question_id, score, is_correct, comment, updated_at)
      VALUES (?, ?, ?, ?, '', ?)
      ON CONFLICT(attempt_id, question_id) DO UPDATE SET
        score = excluded.score,
        is_correct = excluded.is_correct,
        updated_at = excluded.updated_at
    `);
    for (const response of responses) {
      if (response.input_mode === "mcq") {
        const correct =
          response.answer_text.trim().toUpperCase() === String(response.correct_value).toUpperCase();
        upsertGrade.run(
          attemptId,
          response.question_id,
          correct ? response.max_points : 0,
          correct ? 1 : 0,
          timestamp,
        );
      }
      if (response.input_mode === "numeric") {
        const parsed = parseNumericAnswer(response.answer_text);
        const correct =
          parsed &&
          parsed.decimals === response.required_decimals &&
          Math.abs(parsed.value - response.numeric_value) <= response.numeric_tolerance;
        upsertGrade.run(
          attemptId,
          response.question_id,
          correct ? response.max_points : 0,
          correct ? 1 : 0,
          timestamp,
        );
      }
      if (response.text_answers_json) {
        const correct = textResponseIsCorrect(
          response.answer_text,
          response.text_answers_json,
          Boolean(response.text_case_sensitive),
        );
        upsertGrade.run(
          attemptId,
          response.question_id,
          correct ? response.max_points : 0,
          correct ? 1 : 0,
          timestamp,
        );
      }
    }
    audit(request.user.id, "lock_attempt", "attempt", attemptId, { maxScore });
    return { id: attemptId, ok: true, message: "已锁定" };
  });

  return { results: ids.map(lockOne) };
});

app.get(
  "/api/teacher/attempts/:id",
  { preHandler: requireTeacher },
  async (request, reply) => {
    const attempt = db
      .prepare(`
        SELECT
          a.*, u.username, u.note, e.title AS exercise_title, e.slug AS exercise_slug
        FROM attempts a
        JOIN users u ON u.id = a.user_id
        JOIN exercises e ON e.id = a.exercise_id
        WHERE a.id = ?
      `)
      .get(request.params.id);
    if (!attempt) return reply.code(404).send({ error: "找不到作答。" });
    const items = db
      .prepare(`
        SELECT
          q.id AS question_id, r.answer_text, r.updated_at AS answer_updated_at,
          q.label, q.title, q.type,
          CASE WHEN ak.text_answers_json IS NOT NULL THEN 'text' ELSE q.input_mode END AS input_mode,
          q.max_points, q.prompt_html, q.sort_order,
          ak.answer_html, ak.required_decimals, ak.unit_label,
          CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS answered,
          g.score, g.is_correct, g.comment
        FROM questions q
        JOIN answer_keys ak ON ak.question_id = q.id
        LEFT JOIN responses r
          ON r.attempt_id = ? AND r.question_id = q.id AND TRIM(r.answer_text) <> ''
        LEFT JOIN grading_items g
          ON g.attempt_id = ? AND g.question_id = q.id
        WHERE q.exercise_id = ?
        ORDER BY q.sort_order
      `)
      .all(attempt.id, attempt.id, attempt.exercise_id)
      .map((item) => ({
        ...item,
        answered: Boolean(item.answered),
        is_correct: item.is_correct === null ? null : Boolean(item.is_correct),
      }));
    return {
      attempt: {
        ...attempt,
        statusLabel: statusLabel(attempt.status),
      },
      items,
    };
  },
);

app.put(
  "/api/teacher/attempts/:id/grading",
  { preHandler: requireTeacher },
  async (request, reply) => {
    const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(request.params.id);
    if (!attempt) return reply.code(404).send({ error: "找不到作答。" });
    if (attempt.status !== "grading") {
      return reply.code(409).send({ error: "该作答不在批改状态。" });
    }
    const grades = Array.isArray(request.body?.grades) ? request.body.grades : [];
    const timestamp = nowIso();
    const saveTransaction = db.transaction(() => {
      const questionLookup = db.prepare(`
        SELECT
          q.id, q.max_points,
          CASE WHEN ak.text_answers_json IS NOT NULL THEN 'text' ELSE q.input_mode END AS input_mode
        FROM responses r
        JOIN questions q ON q.id = r.question_id
        JOIN answer_keys ak ON ak.question_id = q.id
        WHERE r.attempt_id = ? AND q.id = ?
      `);
      const upsert = db.prepare(`
        INSERT INTO grading_items
          (attempt_id, question_id, score, is_correct, comment, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id, question_id) DO UPDATE SET
          score = excluded.score,
          is_correct = excluded.is_correct,
          comment = excluded.comment,
          updated_at = excluded.updated_at
      `);
      for (const grade of grades) {
        const question = questionLookup.get(attempt.id, grade.questionId);
        if (!question) continue;
        const score = Number(grade.score);
        if (!Number.isFinite(score) || score < 0 || score > question.max_points) {
          throw new Error(`题目 ${grade.questionId} 的得分无效。`);
        }
        upsert.run(
          attempt.id,
          question.id,
          score,
          score >= question.max_points ? 1 : 0,
          String(grade.comment ?? "").trim().slice(0, 2000),
          timestamp,
        );
      }
      db.prepare(`
        UPDATE attempts SET overall_comment = ?, updated_at = ? WHERE id = ?
      `).run(String(request.body?.overallComment ?? "").trim().slice(0, 4000), timestamp, attempt.id);
    });
    try {
      saveTransaction();
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
    audit(request.user.id, "save_grading", "attempt", attempt.id);
    return { ok: true };
  },
);

app.post(
  "/api/teacher/attempts/:id/publish",
  { preHandler: requireTeacher },
  async (request, reply) => {
    const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(request.params.id);
    if (!attempt) return reply.code(404).send({ error: "找不到作答。" });
    if (attempt.status !== "grading") {
      return reply.code(409).send({ error: "该作答不在批改状态。" });
    }
    const pending = db
      .prepare(`
        SELECT q.label
        FROM responses r
        JOIN questions q ON q.id = r.question_id
        LEFT JOIN grading_items g
          ON g.attempt_id = r.attempt_id AND g.question_id = r.question_id
        WHERE r.attempt_id = ? AND TRIM(r.answer_text) <> '' AND g.id IS NULL
        ORDER BY q.sort_order
      `)
      .all(attempt.id);
    if (pending.length) {
      return reply.code(400).send({
        error: `以下题目尚未给分：${pending.map((item) => item.label).join("、")}`,
      });
    }
    const total = db
      .prepare("SELECT COALESCE(SUM(score), 0) AS total FROM grading_items WHERE attempt_id = ?")
      .get(attempt.id).total;
    const timestamp = nowIso();
    db.prepare(`
      UPDATE attempts
      SET status = 'published', total_score = ?, published_at = ?, updated_at = ?
      WHERE id = ?
    `).run(total, timestamp, timestamp, attempt.id);
    audit(request.user.id, "publish_attempt", "attempt", attempt.id, { total });
    return { ok: true, totalScore: total, maxScore: attempt.max_score };
  },
);

app.post(
  "/api/teacher/attempts/:id/reopen",
  { preHandler: requireTeacher },
  async (request, reply) => {
    const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(request.params.id);
    if (!attempt) return reply.code(404).send({ error: "找不到作答。" });
    const transaction = db.transaction(() => {
      db.prepare("DELETE FROM grading_items WHERE attempt_id = ?").run(attempt.id);
      db.prepare(`
        UPDATE attempts
        SET status = 'draft', total_score = NULL, max_score = NULL,
            overall_comment = '', locked_at = NULL, published_at = NULL, updated_at = ?
        WHERE id = ?
      `).run(nowIso(), attempt.id);
    });
    transaction();
    audit(request.user.id, "reopen_attempt", "attempt", attempt.id);
    return { ok: true };
  },
);

app.get(
  "/api/teacher/stats/:exerciseId",
  { preHandler: requireTeacher },
  async (request) => {
    const rows = db
      .prepare(`
        SELECT
          q.id, q.label, q.type, q.input_mode, q.max_points, q.sort_order,
          (
            SELECT COUNT(*)
            FROM responses r
            JOIN attempts a ON a.id = r.attempt_id
            WHERE r.question_id = q.id AND TRIM(r.answer_text) <> ''
          ) AS answered_count,
          (
            SELECT COUNT(*)
            FROM grading_items g
            WHERE g.question_id = q.id
          ) AS graded_count,
          (
            SELECT COUNT(*)
            FROM grading_items g
            WHERE g.question_id = q.id AND g.score >= q.max_points
          ) AS full_correct_count,
          (
            SELECT COALESCE(SUM(g.score), 0)
            FROM grading_items g
            WHERE g.question_id = q.id
          ) AS score_sum
        FROM questions q
        WHERE q.exercise_id = ?
        ORDER BY q.sort_order
      `)
      .all(request.params.exerciseId)
      .map((row) => ({
        ...row,
        correctRate:
          row.graded_count > 0 ? (row.full_correct_count / row.graded_count) * 100 : null,
        averageScoreRate:
          row.graded_count > 0
            ? (row.score_sum / (row.max_points * row.graded_count)) * 100
            : null,
      }));
    return { stats: rows };
  },
);

app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith("/api/")) {
    return reply.code(404).send({ error: "接口不存在。" });
  }
  return reply.sendFile("index.html");
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
  return reply
    .code(statusCode)
    .send({ error: statusCode === 500 ? "服务器暂时无法处理请求。" : error.message });
});

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
await app.listen({ host, port });
