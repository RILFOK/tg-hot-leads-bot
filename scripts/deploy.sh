#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
)"

cd "$ROOT_DIR"

fail() {
  echo "DEPLOY_ERROR: $*" >&2
  exit 1
}

command -v git >/dev/null ||
  fail "git не найден"

command -v npm >/dev/null ||
  fail "npm не найден"

command -v pm2 >/dev/null ||
  fail "pm2 не найден"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "на сервере есть незакоммиченные изменения"
fi

PREVIOUS_COMMIT="$(git rev-parse HEAD)"

echo "===== FETCH ====="
echo "Текущий commit: $PREVIOUS_COMMIT"

git fetch origin main
git merge --ff-only origin/main

echo
echo "===== INSTALL ====="

npm ci \
  --no-audit \
  --no-fund

echo
echo "===== CHECK ====="

npm run check

echo
echo "===== DATABASE BACKUP ====="

npm run backup

echo
echo "===== DATABASE SCHEMA ====="

npm run db:push

echo
echo "===== PRODUCTION DEPENDENCIES ====="

npm prune \
  --omit=dev \
  --no-audit \
  --no-fund

echo
echo "===== PM2 ====="

pm2 startOrReload \
  ecosystem.config.cjs \
  --env production \
  --update-env

pm2 save

sleep 5

echo
echo "===== HEALTH ====="

npm run health

echo
echo "DEPLOY_OK"
echo "Previous commit: $PREVIOUS_COMMIT"
echo "Current commit:  $(git rev-parse HEAD)"
