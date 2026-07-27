#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

DATABASE_PATH="${DATABASE_PATH:-/var/lib/physics-practice/practice.db}"
EXERCISE_STORAGE_DIR="${EXERCISE_STORAGE_DIR:-/var/lib/physics-practice/exercise-content}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/physics-practice/backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

if [[ ! -f "$DATABASE_PATH" ]]; then
  echo "数据库尚未创建，跳过备份。"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temporary_file="$(mktemp "$BACKUP_DIR/.practice-${timestamp}-XXXXXX.sqlite")"
final_file="$BACKUP_DIR/practice-${timestamp}.sqlite.gz"
content_file="$BACKUP_DIR/exercise-content-${timestamp}.tar.gz"

cleanup() {
  rm -f "$temporary_file"
}
trap cleanup EXIT

sqlite3 "$DATABASE_PATH" ".timeout 5000" ".backup '$temporary_file'"
gzip -9 -c "$temporary_file" > "$final_file"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'practice-*.sqlite.gz' \
  -mtime "+$BACKUP_KEEP_DAYS" -delete

if [[ -d "$EXERCISE_STORAGE_DIR" ]]; then
  tar -C "$(dirname "$EXERCISE_STORAGE_DIR")" \
    -czf "$content_file" "$(basename "$EXERCISE_STORAGE_DIR")"
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'exercise-content-*.tar.gz' \
    -mtime "+$BACKUP_KEEP_DAYS" -delete
  echo "上传内容备份完成：$content_file"
fi

echo "数据库备份完成：$final_file"
