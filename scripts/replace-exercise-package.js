import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { parseExercisePackage } from "../server/exercise-package.js";

const packagePath = path.resolve(process.argv[2] || "");
const clearAttempts = process.argv.includes("--clear-attempts");
const databasePath = process.env.DATABASE_PATH;
const storageRoot = process.env.EXERCISE_STORAGE_DIR;
const backupDirectory = process.env.BACKUP_DIR;

if (!process.argv[2] || !fs.existsSync(packagePath)) {
  throw new Error("用法：node scripts/replace-exercise-package.js 练习包.zip [--clear-attempts]");
}
if (!databasePath || !storageRoot || !backupDirectory) {
  throw new Error("必须设置 DATABASE_PATH、EXERCISE_STORAGE_DIR 和 BACKUP_DIR。");
}

const rawPackage = fs.readFileSync(packagePath);
const parsed = parseExercisePackage(rawPackage);
const { exercise } = parsed;
const db = new Database(databasePath);
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

const answerColumns = db.prepare("PRAGMA table_info(answer_keys)").all();
if (!answerColumns.some((column) => column.name === "text_answers_json")) {
  throw new Error("数据库尚未升级文本填空字段，请先部署并启动新版网站。");
}

const existing = db.prepare("SELECT * FROM exercises WHERE slug = ?").get(exercise.slug);
if (existing && !clearAttempts) {
  const attemptCount = db
    .prepare("SELECT COUNT(*) AS count FROM attempts WHERE exercise_id = ?")
    .get(existing.id).count;
  if (attemptCount) {
    throw new Error(`练习已有 ${attemptCount} 份学生作答；请明确使用 --clear-attempts。`);
  }
}

fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
const timestamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "Z");
const temporaryBackup = path.join(backupDirectory, `.replace-${exercise.slug}-${timestamp}.sqlite`);
const backupName = `practice-before-replace-${exercise.slug}-${timestamp}.sqlite.gz`;
await db.backup(temporaryBackup);
fs.writeFileSync(
  path.join(backupDirectory, backupName),
  zlib.gzipSync(fs.readFileSync(temporaryBackup), { level: 9 }),
  { mode: 0o600 },
);
fs.rmSync(temporaryBackup, { force: true });

const replaceTransaction = db.transaction(() => {
  if (clearAttempts) db.prepare("DELETE FROM attempts").run();
  if (existing) db.prepare("DELETE FROM exercises WHERE id = ?").run(existing.id);
  db.prepare("DELETE FROM deleted_exercises WHERE slug = ?").run(exercise.slug);

  const createdAt = new Date().toISOString();
  const visible = existing ? existing.visible : exercise.visible;
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
      visible,
      createdAt,
      createdAt,
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
  db.prepare(`
    INSERT INTO audit_logs
      (actor_user_id, action, target_type, target_id, details_json, created_at)
    VALUES (NULL, 'replace_exercise_package', 'exercise', ?, ?, ?)
  `).run(
    exercise.slug,
    JSON.stringify({ clearAttempts, questionCount: exercise.questionCount }),
    createdAt,
  );
});

replaceTransaction();
db.close();

const assetsDirectory = path.join(storageRoot, "assets", exercise.slug);
const packagesDirectory = path.join(storageRoot, "packages");
fs.rmSync(assetsDirectory, { recursive: true, force: true });
fs.mkdirSync(assetsDirectory, { recursive: true, mode: 0o700 });
for (const asset of parsed.assets) {
  const destination = path.resolve(assetsDirectory, asset.name);
  const relative = path.relative(assetsDirectory, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("素材文件路径无效。");
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, asset.data, { mode: 0o600 });
}
fs.mkdirSync(packagesDirectory, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(packagesDirectory, `${exercise.slug}.zip`), rawPackage, {
  mode: 0o600,
});

console.log(
  JSON.stringify(
    {
      ok: true,
      slug: exercise.slug,
      questions: exercise.questionCount,
      textQuestions: exercise.questions.filter((question) => question.inputMode === "text").length,
      clearedAttempts: clearAttempts,
      backup: backupName,
    },
    null,
    2,
  ),
);
