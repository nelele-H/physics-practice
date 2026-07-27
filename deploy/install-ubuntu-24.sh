#!/usr/bin/env bash
set -Eeuo pipefail

APP_USER="${APP_USER:-physics-practice}"
APP_GROUP="${APP_GROUP:-physics-practice}"
APP_DIR="${APP_DIR:-/opt/physics-practice}"
DATA_DIR="${DATA_DIR:-/var/lib/physics-practice}"
CONFIG_DIR="${CONFIG_DIR:-/etc/physics-practice}"
NODE_MAJOR="${NODE_MAJOR:-24}"
PNPM_VERSION="${PNPM_VERSION:-10.33.2}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "错误：$*" >&2
  exit 1
}

[[ "$EUID" -eq 0 ]] || fail "请使用 sudo bash deploy/install-ubuntu-24.sh 运行。"
[[ -f "$SOURCE_DIR/package.json" ]] || fail "找不到 package.json，请从完整发布包内运行。"
[[ "$APP_DIR" == /opt/* && "$APP_DIR" != "/opt/" ]] ||
  fail "APP_DIR 必须是 /opt 下的独立应用目录。"

source /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] ||
  fail "此脚本只支持 Ubuntu 24.04。"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg nginx sqlite3 rsync build-essential python3 ufw

current_node_major=0
if command -v node >/dev/null 2>&1; then
  current_node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
fi
if (( current_node_major < NODE_MAJOR )); then
  node_setup="$(mktemp)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$node_setup"
  bash "$node_setup"
  rm -f "$node_setup"
  apt-get install -y nodejs
fi

installed_node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
(( installed_node_major >= NODE_MAJOR )) ||
  fail "Node.js 安装失败，需要 ${NODE_MAJOR}.x 或更高版本。"
npm install --global "pnpm@${PNPM_VERSION}"

if ! getent group "$APP_GROUP" >/dev/null; then
  groupadd --system "$APP_GROUP"
fi
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --gid "$APP_GROUP" --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

install -d -m 0750 -o "$APP_USER" -g "$APP_GROUP" "$APP_DIR"
install -d -m 0750 -o "$APP_USER" -g "$APP_GROUP" "$DATA_DIR" "$DATA_DIR/backups"
install -d -m 0750 -o root -g "$APP_GROUP" "$CONFIG_DIR"

if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
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
fi

chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
runuser -u "$APP_USER" -- env HOME="$APP_DIR" \
  pnpm --dir "$APP_DIR" install --prod --frozen-lockfile
chown -R root:"$APP_GROUP" "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 0755 {} +
find "$APP_DIR" -type f -exec chmod u=rw,g=r,o=r {} +

environment_file="$CONFIG_DIR/physics-practice.env"
if [[ ! -f "$environment_file" ]]; then
  install -m 0640 -o root -g "$APP_GROUP" \
    "$APP_DIR/deploy/physics-practice.env.example" "$environment_file"
fi

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
ln -sfn /etc/nginx/sites-available/physics-practice \
  /etc/nginx/sites-enabled/physics-practice
rm -f /etc/nginx/sites-enabled/default

database_path="$DATA_DIR/practice.db"
if [[ ! -f "$database_path" ]]; then
  echo
  echo "首次部署需要创建教师账号。密码输入时不会显示。"
  read -r -p "教师用户名： " teacher_username
  read -r -s -p "教师密码： " teacher_password
  echo
  [[ -n "$teacher_username" && -n "$teacher_password" ]] ||
    fail "教师用户名和密码不能为空。"
  runuser -u "$APP_USER" -- env \
    HOME="$DATA_DIR" \
    DATABASE_PATH="$database_path" \
    TEACHER_USERNAME="$teacher_username" \
    TEACHER_PASSWORD="$teacher_password" \
    /usr/bin/node "$APP_DIR/scripts/seed-teacher.js"
  unset teacher_password
fi

nginx -t
systemctl daemon-reload
systemctl enable --now physics-practice.service
systemctl enable --now physics-practice-backup.timer
systemctl enable --now nginx

ufw limit 12345/tcp >/dev/null
ufw allow 'Nginx HTTP' >/dev/null

for _ in {1..20}; do
  if curl -fsS http://127.0.0.1:10123/api/health >/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS http://127.0.0.1:10123/api/health >/dev/null ||
  fail "服务启动后健康检查失败，请运行 journalctl -u physics-practice -n 100 查看日志。"

echo
echo "部署完成。"
echo "访问地址：http://服务器公网IP:80/"
echo "防火墙规则已准备；如果 UFW 尚未启用，请确认 SSH 可用后执行：sudo ufw enable"
echo "服务状态：sudo systemctl status physics-practice"
