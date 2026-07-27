import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, "..");
const databaseDir = path.join(projectRoot, "database");
const databasePath = process.env.DATABASE_PATH || path.join(databaseDir, "practice.db");
const contentPath = path.join(projectRoot, "content", "exercises.json");

fs.mkdirSync(databaseDir, { recursive: true });

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

export function nowIso() {
  return new Date().toISOString();
}

export function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
      note TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activation_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      note TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT NOT NULL,
      page TEXT NOT NULL,
      total_points REAL NOT NULL,
      question_count INTEGER NOT NULL,
      visible INTEGER NOT NULL DEFAULT 1,
      source_type TEXT NOT NULL DEFAULT 'built_in',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deleted_exercises (
      slug TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      parent_number INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK (type IN ('mcq', 'manual')),
      input_mode TEXT NOT NULL DEFAULT 'manual' CHECK (input_mode IN ('mcq', 'numeric', 'manual')),
      max_points REAL NOT NULL,
      prompt_html TEXT NOT NULL,
      options_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS answer_keys (
      question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
      correct_value TEXT,
      answer_html TEXT NOT NULL,
      numeric_value REAL,
      numeric_tolerance REAL,
      required_decimals INTEGER,
      unit_label TEXT
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'grading', 'published')),
      total_score REAL,
      max_score REAL,
      overall_comment TEXT NOT NULL DEFAULT '',
      locked_at TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (user_id, exercise_id)
    );

    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      answer_text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (attempt_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS grading_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      is_correct INTEGER NOT NULL DEFAULT 0,
      comment TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      UNIQUE (attempt_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS attempts_exercise_status_idx ON attempts(exercise_id, status);
    CREATE INDEX IF NOT EXISTS responses_question_idx ON responses(question_id);
    CREATE INDEX IF NOT EXISTS grading_question_idx ON grading_items(question_id);
  `);

  ensureColumn("questions", "input_mode", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn("answer_keys", "numeric_value", "REAL");
  ensureColumn("answer_keys", "numeric_tolerance", "REAL");
  ensureColumn("answer_keys", "required_decimals", "INTEGER");
  ensureColumn("answer_keys", "unit_label", "TEXT");
  ensureColumn("exercises", "source_type", "TEXT NOT NULL DEFAULT 'built_in'");

  seedExerciseContent();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function seedExerciseContent() {
  if (!fs.existsSync(contentPath)) {
    throw new Error("缺少 content/exercises.json，请先运行 npm run build:content。");
  }
  const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
  const timestamp = nowIso();

  const upsertExercise = db.prepare(`
    INSERT INTO exercises
      (slug, code, title, subtitle, page, total_points, question_count, created_at, updated_at)
    VALUES
      (@slug, @code, @title, @subtitle, @page, @totalPoints, @questionCount, @createdAt, @updatedAt)
    ON CONFLICT(slug) DO UPDATE SET
      code = excluded.code,
      title = excluded.title,
      subtitle = excluded.subtitle,
      page = excluded.page,
      total_points = excluded.total_points,
      question_count = excluded.question_count,
      updated_at = excluded.updated_at
  `);

  const upsertQuestion = db.prepare(`
    INSERT INTO questions
      (id, exercise_id, label, parent_number, title, type, input_mode, max_points, prompt_html, options_json, sort_order)
    VALUES
      (@id, @exerciseId, @label, @parentNumber, @title, @type, @inputMode, @maxPoints, @promptHtml, @optionsJson, @sortOrder)
    ON CONFLICT(id) DO UPDATE SET
      exercise_id = excluded.exercise_id,
      label = excluded.label,
      parent_number = excluded.parent_number,
      title = excluded.title,
      type = excluded.type,
      input_mode = excluded.input_mode,
      max_points = excluded.max_points,
      prompt_html = excluded.prompt_html,
      options_json = excluded.options_json,
      sort_order = excluded.sort_order
  `);

  const upsertAnswer = db.prepare(`
    INSERT INTO answer_keys
      (question_id, correct_value, answer_html, numeric_value, numeric_tolerance, required_decimals, unit_label)
    VALUES
      (@questionId, @correctValue, @answerHtml, @numericValue, @numericTolerance, @requiredDecimals, @unitLabel)
    ON CONFLICT(question_id) DO UPDATE SET
      correct_value = excluded.correct_value,
      answer_html = excluded.answer_html,
      numeric_value = excluded.numeric_value,
      numeric_tolerance = excluded.numeric_tolerance,
      required_decimals = excluded.required_decimals,
      unit_label = excluded.unit_label
  `);

  const transaction = db.transaction(() => {
    for (const exercise of content.exercises) {
      const deleted = db
        .prepare("SELECT 1 FROM deleted_exercises WHERE slug = ?")
        .get(exercise.slug);
      if (deleted) continue;
      upsertExercise.run({
        ...exercise,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const exerciseRow = db.prepare("SELECT id FROM exercises WHERE slug = ?").get(exercise.slug);
      for (const question of exercise.questions) {
        upsertQuestion.run({
          ...question,
          exerciseId: exerciseRow.id,
          optionsJson: JSON.stringify(question.options ?? []),
        });
        upsertAnswer.run({
          questionId: question.id,
          correctValue: question.correctValue,
          answerHtml: question.answerHtml,
          numericValue: question.numericValue,
          numericTolerance: question.numericTolerance,
          requiredDecimals: question.requiredDecimals,
          unitLabel: question.unitLabel,
        });
      }
    }
  });
  transaction();
}

export function ensureTeacher(username, password) {
  const existing = db.prepare("SELECT id FROM users WHERE role = 'teacher' LIMIT 1").get();
  if (existing) return { created: false, id: existing.id };
  if (!username || !password) {
    throw new Error(
      "数据库中没有教师账号。请设置 BOOTSTRAP_TEACHER_USERNAME 和 BOOTSTRAP_TEACHER_PASSWORD 后启动，或运行 seed:teacher。",
    );
  }
  const timestamp = nowIso();
  const result = db
    .prepare(`
      INSERT INTO users
        (username, password_hash, role, note, active, must_change_password, created_at, updated_at)
      VALUES (?, ?, 'teacher', '系统教师账号', 1, 0, ?, ?)
    `)
    .run(username.trim(), bcrypt.hashSync(password, 12), timestamp, timestamp);
  return { created: true, id: Number(result.lastInsertRowid) };
}

export function audit(actorUserId, action, targetType, targetId, details = {}) {
  db.prepare(`
    INSERT INTO audit_logs
      (actor_user_id, action, target_type, target_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actorUserId ?? null, action, targetType, String(targetId), JSON.stringify(details), nowIso());
}

initializeDatabase();
