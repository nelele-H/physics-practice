import fs from "node:fs";
import bcrypt from "bcryptjs";
import { db, nowIso } from "../server/db.js";

function fail(message) {
  console.error(`创建失败：${message}`);
  db.close();
  process.exit(1);
}

const username = String(process.argv[2] ?? "").normalize("NFKC").trim();
const password = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
const usernameLength = Array.from(username).length;
const passwordLength = Array.from(password).length;

if (usernameLength < 3 || usernameLength > 80) {
  fail("教师用户名需要 3–80 个字符。");
}
if (!/^[\p{L}\p{N}][\p{L}\p{N}@._+-]*$/u.test(username)) {
  fail("用户名只能使用中英文字母、数字及 @ . _ + -，并且必须以文字或数字开头。");
}
if (passwordLength < 8 || passwordLength > 128) {
  fail("教师密码需要 8–128 个字符。");
}
if (password.normalize("NFKC").toLocaleLowerCase() === username.toLocaleLowerCase()) {
  fail("密码不能与用户名相同。");
}

const existing = db
  .prepare("SELECT id, role FROM users WHERE username = ? COLLATE NOCASE")
  .get(username);
if (existing) {
  fail(`用户名已被${existing.role === "teacher" ? "教师" : "学生"}账号使用。`);
}

const timestamp = nowIso();
const result = db
  .prepare(`
    INSERT INTO users
      (username, password_hash, role, note, active, must_change_password, created_at, updated_at)
    VALUES (?, ?, 'teacher', '服务器控制台创建的教师账号', 1, 0, ?, ?)
  `)
  .run(username, bcrypt.hashSync(password, 12), timestamp, timestamp);

console.log(`教师账号已创建：${username}（ID ${result.lastInsertRowid}）`);
db.close();
