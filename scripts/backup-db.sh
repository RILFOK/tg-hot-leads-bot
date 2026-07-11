#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"

cd "$ROOT_DIR"

fail() {
  echo "BACKUP_ERROR: $*" >&2
  exit 1
}

command -v node >/dev/null ||
  fail "node не найден"

command -v pg_dump >/dev/null ||
  fail "pg_dump не найден"

command -v pg_restore >/dev/null ||
  fail "pg_restore не найден"

[[ -f .env ]] ||
  fail "не найден $ROOT_DIR/.env"

DATABASE_URL="$(
  node --input-type=module -e '
    import "dotenv/config";

    const value =
      process.env.DATABASE_URL?.trim();

    if (!value) {
      process.exit(2);
    }

    process.stdout.write(value);
  '
)" || fail "DATABASE_URL не найден"

PSQL_URL="${DATABASE_URL%%\?*}"

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/tg-hot-leads-bot}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

if [[ ! "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  fail "BACKUP_RETENTION_DAYS должен быть целым числом"
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
FINAL_FILE="$BACKUP_DIR/tg_hot_leads_bot-$TIMESTAMP.dump"
TEMP_FILE="$FINAL_FILE.tmp"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

cleanup() {
  rm -f "$TEMP_FILE"
}

trap cleanup EXIT

pg_dump "$PSQL_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$TEMP_FILE"

pg_restore --list "$TEMP_FILE" \
  >/dev/null

mv "$TEMP_FILE" "$FINAL_FILE"
chmod 600 "$FINAL_FILE"

find "$BACKUP_DIR" \
  -type f \
  -name 'tg_hot_leads_bot-*.dump' \
  -mtime +"$RETENTION_DAYS" \
  -delete

echo "BACKUP_OK: $FINAL_FILE"
du -h "$FINAL_FILE"

unset DATABASE_URL PSQL_URL
