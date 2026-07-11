#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"

cd "$ROOT_DIR"

fail() {
  echo "HEALTH_ERROR: $*" >&2
  exit 1
}

echo "===== PM2 ====="

command -v pm2 >/dev/null ||
  fail "pm2 не найден"

BOT_PID="$(pm2 pid tg-hot-leads-bot | tail -1)"

if [[ ! "$BOT_PID" =~ ^[1-9][0-9]*$ ]]; then
  fail "процесс tg-hot-leads-bot не запущен"
fi

kill -0 "$BOT_PID" 2>/dev/null ||
  fail "PM2 PID $BOT_PID недоступен"

echo "tg-hot-leads-bot: online, pid=$BOT_PID"

echo
echo "===== XRAY ====="

systemctl is-active --quiet xray ||
  fail "Xray не активен"

ss -lnt |
  grep -q '127\.0\.0\.1:10808' ||
  fail "SOCKS-порт 127.0.0.1:10808 не слушается"

echo "xray: active"

echo
echo "===== TELEGRAM THROUGH XRAY ====="

HTTP_CODE="$(
  curl \
    --socks5-hostname 127.0.0.1:10808 \
    --connect-timeout 10 \
    --max-time 20 \
    -sS \
    -o /dev/null \
    -w '%{http_code}' \
    https://api.telegram.org
)"

case "$HTTP_CODE" in
  2??|3??)
    echo "Telegram API: HTTP $HTTP_CODE"
    ;;
  *)
    fail "Telegram API вернул HTTP $HTTP_CODE"
    ;;
esac

echo
echo "===== POSTGRESQL ====="

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

DB_RESULT="$(
  psql "$PSQL_URL" \
    -Atqc 'SELECT 1;'
)"

[[ "$DB_RESULT" == "1" ]] ||
  fail "PostgreSQL не ответил"

echo "PostgreSQL: connected"

echo
echo "===== DISK ====="

DISK_USED="$(
  df -P / |
  awk 'NR == 2 {
    gsub("%", "", $5);
    print $5
  }'
)"

echo "Использовано: ${DISK_USED}%"

if (( DISK_USED >= 95 )); then
  fail "критически мало места на диске"
elif (( DISK_USED >= 85 )); then
  echo "HEALTH_WARNING: диск заполнен на ${DISK_USED}%"
fi

echo
echo "HEALTH_OK"

unset DATABASE_URL PSQL_URL
