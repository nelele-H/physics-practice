import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dataPath = path.join(root, "content", "exercises.json");
const databasePath = path.join(root, "database", "practice.db");

const required = [
  "public/index.html",
  "public/activate.html",
  "public/student.html",
  "public/teacher.html",
  "public/practice.html",
  "public/downloads/exercise-package-template.zip",
  "public/practice/topic1a-motion.html",
  "public/practice/topic1b-energy.html",
  "public/practice/topic1c-momentum.html",
  "public/practice/topic1-mechanics-test.html",
  "public/assets/styles.css",
  "server/app.js",
  "server/db.js",
  "server/exercise-package.js",
  "scripts/create-teacher.js",
  "deploy/create-teacher.sh",
  "UI设计说明.md",
  "新增练习包格式.md",
];

const missing = required.filter((relative) => !fs.existsSync(path.join(root, relative)));
if (missing.length) {
  console.error(`缺少文件：\n${missing.join("\n")}`);
  process.exit(1);
}

if (!fs.existsSync(dataPath)) {
  console.error("缺少 content/exercises.json，请先运行 npm run build:content。");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const questions = data.exercises.flatMap((exercise) => exercise.questions);
const missingAnswers = questions.filter((question) => !question.answerHtml);
const allowedModes = new Set(["mcq", "numeric", "manual"]);
const invalidModes = questions.filter((question) => !allowedModes.has(question.inputMode));
const invalidNumeric = questions.filter(
  (question) =>
    question.inputMode === "numeric" &&
    (!Number.isFinite(question.numericValue) ||
      !Number.isFinite(question.numericTolerance) ||
      !Number.isInteger(question.requiredDecimals) ||
      question.requiredDecimals < 0 ||
      !question.unitLabel),
);
const modeCounts = Object.fromEntries(
  [...allowedModes].map((mode) => [
    mode,
    questions.filter((question) => question.inputMode === mode).length,
  ]),
);

if (
  data.exercises.length !== 4 ||
  missingAnswers.length ||
  invalidModes.length ||
  invalidNumeric.length
) {
  console.error("练习数据检查失败。");
  if (missingAnswers.length) console.error(`缺少答案：${missingAnswers.length} 题。`);
  if (invalidModes.length) console.error(`题型无效：${invalidModes.length} 题。`);
  if (invalidNumeric.length) console.error(`数值题规则不完整：${invalidNumeric.length} 题。`);
  process.exit(1);
}

if (!fs.existsSync(databasePath)) {
  console.error("缺少 database/practice.db。");
  process.exit(1);
}

const database = new Database(databasePath, { readonly: true, fileMustExist: true });
const teacherCount = database
  .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'teacher' AND active = 1")
  .get().count;
const studentCount = database
  .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'student'")
  .get().count;
const attemptCount = database.prepare("SELECT COUNT(*) AS count FROM attempts").get().count;
const databaseQuestions = database.prepare("SELECT COUNT(*) AS count FROM questions").get().count;
const deletedSlugs = new Set(
  database.prepare("SELECT slug FROM deleted_exercises").all().map((row) => row.slug),
);
const expectedQuestions = data.exercises
  .filter((exercise) => !deletedSlugs.has(exercise.slug))
  .flatMap((exercise) => exercise.questions);
const missingDatabaseQuestions = expectedQuestions.filter(
  (question) => !database.prepare("SELECT 1 FROM questions WHERE id = ?").get(question.id),
);
const databaseModeCounts = Object.fromEntries(
  database
    .prepare("SELECT input_mode AS mode, COUNT(*) AS count FROM questions GROUP BY input_mode")
    .all()
    .map((row) => [row.mode, row.count]),
);
database.close();

if (
  teacherCount < 1 ||
  databaseQuestions < expectedQuestions.length ||
  missingDatabaseQuestions.length
) {
  console.error("数据库初始化检查失败。");
  process.exit(1);
}

console.log(
  `检查通过：${data.exercises.length} 套练习，${questions.length} 个可作答小题（选择 ${modeCounts.mcq}、数值填空 ${modeCounts.numeric}、主观 ${modeCounts.manual}），全部含评分答案且数值规则完整；教师账号 ${teacherCount} 个，学生账号 ${studentCount} 个，作答记录 ${attemptCount} 条。`,
);
