#!/usr/bin/env bash
set -Eeuo pipefail

APP_USER="${APP_USER:-physics-practice}"
APP_GROUP="${APP_GROUP:-physics-practice}"
APP_DIR="${APP_DIR:-/opt/physics-practice}"
PNPM_VERSION="${PNPM_VERSION:-10.33.2}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODE_BACKUP_DIR="/var/backups/physics-practice-code"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$CODE_BACKUP_DIR/code-$timestamp.tar.gz"

fail() {
  echo "错误：$*" >&2
  exit 1
}

[[ "$EUID" -eq 0 ]] || fail "请使用 sudo bash deploy/update-ubuntu-24.sh 运行。"
[[ -f "$SOURCE_DIR/package.json" ]] || fail "找不到 package.json，请从完整发布包内运行。"
[[ "$APP_DIR" == /opt/* && "$APP_DIR" != "/opt/" ]] ||
  fail "APP_DIR 必须是 /opt 下的独立应用目录。"
[[ -d "$APP_DIR" ]] || fail "应用尚未安装，请先运行首次安装脚本。"
[[ "$SOURCE_DIR" != "$APP_DIR" ]] || fail "请从新的临时发布目录运行更新脚本。"

mkdir -p "$CODE_BACKUP_DIR"
systemctl start physics-practice-backup.service || true
tar -C "$(dirname "$APP_DIR")" -czf "$archive" "$(basename "$APP_DIR")"

rollback() {
  trap - ERR
  set +e
  echo "更新失败，正在恢复上一版本……" >&2
  systemctl stop physics-practice.service
  rm -rf "$APP_DIR"
  tar -C "$(dirname "$APP_DIR")" -xzf "$archive"
  systemctl daemon-reload
  systemctl restart physics-practice.service
  echo "已恢复上一版本。数据库未被替换。" >&2
}
trap rollback ERR

systemctl stop physics-practice.service
rsync -a --delete \
  --exclude node_modules/ \
  --exclude logs/ \
  --exclude release/ \
  --exclude .env \
  --exclude 'database/*.db' \
  --exclude 'database/*.db-shm' \
  --exclude 'database/*.db-wal' \
  --exclude database/backups/ \
  --exclude database/exercise-content/ \
  "$SOURCE_DIR/" "$APP_DIR/"

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
runuser -u "$APP_USER" -- env HOME="$APP_DIR" \
  pnpm --dir "$APP_DIR" install --prod --frozen-lockfile
chown -R root:"$APP_GROUP" "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 0755 {} +
find "$APP_DIR" -type f -exec chmod u=rw,g=r,o=r {} +

install -m 0644 "$APP_DIR/deploy/physics-practice.service" \
  /etc/systemd/system/physics-practice.service
install -m 0755 "$APP_DIR/deploy/backup.sh" \
  /usr/local/sbin/physics-practice-backup
install -m 0644 "$APP_DIR/deploy/physics-practice-backup.service" \
  /etc/systemd/system/physics-practice-backup.service
install -m 0644 "$APP_DIR/deploy/physics-practice-backup.timer" \
  /etc/systemd/system/physics-practice-backup.timer
install -m 0644 "$APP_DIR/deploy/nginx-physics-practice.conf" \
  /etc/nginx/sites-available/physics-practice

nginx -t
systemctl daemon-reload
systemctl restart physics-practice.service
systemctl reload nginx

for _ in {1..20}; do
  if curl -fsS http://127.0.0.1:10123/api/health >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:10123/api/health >/dev/null

trap - ERR
find "$CODE_BACKUP_DIR" -maxdepth 1 -type f -name 'code-*.tar.gz' -mtime +7 -delete
echo "更新完成，数据库和历史作答均已保留。"
