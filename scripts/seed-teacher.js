import { db, initializeDatabase, nowIso } from "../server/db.js";
import bcrypt from "bcryptjs";

initializeDatabase();

const username = process.env.TEACHER_USERNAME || process.argv[2];
const password = process.env.TEACHER_PASSWORD;

if (!username || !password) {
  console.error(
    "请通过环境变量提供 TEACHER_USERNAME 和 TEACHER_PASSWORD。密码不会写入源码。",
  );
  process.exit(1);
}

const timestamp = nowIso();
const existing = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username);
const passwordHash = bcrypt.hashSync(password, 12);

if (existing) {
  db.prepare(`
    UPDATE users
    SET password_hash = ?, role = 'teacher', active = 1, must_change_password = 0, updated_at = ?
    WHERE id = ?
  `).run(passwordHash, timestamp, existing.id);
  console.log("教师账号已更新。");
} else {
  db.prepare(`
    INSERT INTO users
      (username, password_hash, role, note, active, must_change_password, created_at, updated_at)
    VALUES (?, ?, 'teacher', '系统教师账号', 1, 0, ?, ?)
  `).run(username, passwordHash, timestamp, timestamp);
  console.log("教师账号已创建。");
}
