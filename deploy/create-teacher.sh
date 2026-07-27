#!/usr/bin/env bash
set -Eeuo pipefail

APP_USER="${APP_USER:-physics-practice}"
APP_DIR="${APP_DIR:-/opt/physics-practice}"
CONFIG_FILE="${CONFIG_FILE:-/etc/physics-practice/physics-practice.env}"

fail() {
  echo "错误：$*" >&2
  exit 1
}

[[ "$EUID" -eq 0 ]] || fail "请使用 sudo bash deploy/create-teacher.sh 运行。"
[[ -f "$APP_DIR/scripts/create-teacher.js" ]] || fail "找不到教师账号创建程序。"
[[ -f "$CONFIG_FILE" ]] || fail "找不到服务器配置文件。"
id "$APP_USER" >/dev/null 2>&1 || fail "找不到网站运行账号：$APP_USER"

set -a
# shellcheck disable=SC1090
source "$CONFIG_FILE"
set +a

read -r -p "新教师用户名： " teacher_username
[[ -n "$teacher_username" ]] || fail "用户名不能为空。"

read -r -s -p "新教师密码（至少 8 位）： " teacher_password
echo
read -r -s -p "再次输入密码： " teacher_password_confirm
echo

if [[ "$teacher_password" != "$teacher_password_confirm" ]]; then
  unset teacher_password teacher_password_confirm
  fail "两次输入的密码不一致。"
fi
unset teacher_password_confirm

printf '%s' "$teacher_password" |
  runuser -u "$APP_USER" -- env \
    HOME="${DATABASE_PATH%/*}" \
    DATABASE_PATH="$DATABASE_PATH" \
    /usr/bin/node "$APP_DIR/scripts/create-teacher.js" "$teacher_username"

unset teacher_password
echo "无需重启网站，新教师现在可以登录。"
