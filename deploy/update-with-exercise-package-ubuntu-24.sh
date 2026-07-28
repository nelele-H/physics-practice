#!/usr/bin/env bash
set -Eeuo pipefail

APP_USER="${APP_USER:-physics-practice}"
APP_DIR="${APP_DIR:-/opt/physics-practice}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_PATH="${1:-}"

fail() {
  echo "错误：$*" >&2
  exit 1
}

[[ "$EUID" -eq 0 ]] ||
  fail "请使用 sudo bash deploy/update-with-exercise-package-ubuntu-24.sh 练习包.zip 运行。"
[[ -n "$PACKAGE_PATH" && -f "$PACKAGE_PATH" ]] || fail "找不到要更新的练习包。"
[[ -f "$SOURCE_DIR/deploy/update-ubuntu-24.sh" ]] || fail "发布包不完整。"

bash "$SOURCE_DIR/deploy/update-ubuntu-24.sh"

set -a
# shellcheck disable=SC1091
source /etc/physics-practice/physics-practice.env
set +a

DATABASE_PATH="${DATABASE_PATH:-/var/lib/physics-practice/practice.db}"
EXERCISE_STORAGE_DIR="${EXERCISE_STORAGE_DIR:-/var/lib/physics-practice/exercise-content}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/physics-practice/backups}"

restart_service() {
  systemctl restart physics-practice.service
}
trap restart_service EXIT

systemctl stop physics-practice.service
runuser -u "$APP_USER" -- env \
  DATABASE_PATH="$DATABASE_PATH" \
  EXERCISE_STORAGE_DIR="$EXERCISE_STORAGE_DIR" \
  BACKUP_DIR="$BACKUP_DIR" \
  /usr/bin/node "$APP_DIR/scripts/replace-exercise-package.js" \
  "$PACKAGE_PATH" --clear-attempts
systemctl start physics-practice.service

for _ in {1..20}; do
  if curl -fsS http://127.0.0.1:10123/api/health >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:10123/api/health >/dev/null

trap - EXIT
echo "网站、练习包已更新；学生作答、批改和提交记录已清空，账号均已保留。"
