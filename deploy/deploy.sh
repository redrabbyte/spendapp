#!/usr/bin/env bash
#
# Build and activate a release. Run this on the server you are deploying to,
# from a checkout of this repository:
#
#   ./deploy/setup.sh https://spend.example.com   # once
#   ./deploy/deploy.sh                            # each release
#
# Exports the current commit into a timestamped release directory, builds it,
# backs up and migrates the database, then flips an atomic `current` symlink
# and restarts the service — rolling back if the health check fails.
#
# The public URL comes from APP_ORIGIN in the shared .env, so it is set once
# by setup.sh. Re-run setup.sh with a new URL to change it.
set -euo pipefail

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  cat <<USAGE
usage: $0

env: SPENDAPP_DIR (default /opt/spendapp)
     SPENDAPP_REF (default HEAD) — the commit or tag to deploy
USAGE
  exit 0
fi

APP_DIR=${SPENDAPP_DIR:-/opt/spendapp}
SHARED="$APP_DIR/shared"
REF=${SPENDAPP_REF:-HEAD}
SERVICE_USER=spendapp
KEEP_RELEASES=5
KEEP_BACKUPS=10

SUDO=''
[ "$(id -u)" -ne 0 ] && SUDO=sudo

say() { printf '\n== %s\n' "$*"; }

[ -f "$SHARED/.env" ] || {
  echo "no $SHARED/.env — run ./deploy/setup.sh <public-url> first" >&2
  exit 1
}

cd "$(dirname "$0")/.."
git rev-parse --git-dir >/dev/null 2>&1 || {
  echo "not a git checkout — deploy.sh exports the commit to deploy with git archive" >&2
  exit 1
}
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "warning: working tree is dirty — deploying committed $REF, not the local edits" >&2
fi

stamp=$(date -u +%Y%m%d%H%M%S)
rel="$APP_DIR/releases/$stamp"
sha=$(git rev-parse --short "$REF")

say "export $sha -> $rel"
$SUDO mkdir -p "$rel"
git archive --format=tar "$REF" | $SUDO tar -x -C "$rel"

# config.ts reads apps/server/.env; point it at the shared, unversioned one.
$SUDO ln -sfn "$SHARED/.env" "$rel/apps/server/.env"

say "install"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd "$rel"
$SUDO pnpm install --frozen-lockfile --prod=false

say "build web"
$SUDO pnpm --filter web build

# .env is 0600 and owned by the service user, so a non-root invoker cannot
# open it — read it through sudo instead of sourcing the path. Sourcing and
# eval carry the same risk here (both interpret the file as shell) and the
# file is plain KEY=VALUE written by setup.sh.
set -a
eval "$($SUDO cat "$SHARED/.env")"
set +a

if [ -z "${VAPID_PUBLIC_KEY:-}" ]; then
  say "generating VAPID keys"
  keys=$(cd "$rel/apps/server" && node -e "
    const k = require('web-push').generateVAPIDKeys();
    console.log('VAPID_PUBLIC_KEY=' + k.publicKey);
    console.log('VAPID_PRIVATE_KEY=' + k.privateKey);
  ")
  printf '\n%s\n' "$keys" | $SUDO tee -a "$SHARED/.env" >/dev/null
  set -a
  eval "$keys"
  set +a
  echo "appended VAPID keys to $SHARED/.env"
fi

say "backup"
# Separate assignment so a parse failure fails the deploy (eval would hide it).
dbenv=$(node "$rel/deploy/dburl.mjs")
eval "$dbenv"
$SUDO mkdir -p "$SHARED/backups"
if command -v mysqldump >/dev/null; then
  MYSQL_PWD="$DB_PASS" mysqldump --single-transaction --quick --no-tablespaces \
    -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" \
    | gzip | $SUDO tee "$SHARED/backups/$stamp.sql.gz" >/dev/null
  echo "wrote $SHARED/backups/$stamp.sql.gz"
else
  echo "mysqldump not found — skipping the pre-migration backup" >&2
fi

say "migrate"
# --preserve-env is a sudo flag, so it must vanish along with $SUDO when this
# runs as root — otherwise the shell tries to exec it. DATABASE_URL is already
# exported either way. Keeping it out of argv keeps the password out of `ps`.
# shellcheck disable=SC2086
$SUDO ${SUDO:+--preserve-env=DATABASE_URL} pnpm --filter server db:migrate

say "activate"
prev=$(readlink "$APP_DIR/current" 2>/dev/null || true)
$SUDO chown -R "$SERVICE_USER:$SERVICE_USER" "$rel"
$SUDO ln -sfn "$rel" "$APP_DIR/current"
$SUDO systemctl restart spendapp

# The unit binds 127.0.0.1 — check it directly, before the web server is in
# the picture, so a proxy misconfiguration can't be mistaken for a bad build.
port=${PORT:-3000}
ok=0
for _ in $(seq 1 30); do
  if curl -fsS -m 2 "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done

if [ "$ok" -ne 1 ]; then
  echo "health check failed on 127.0.0.1:$port" >&2
  if [ -n "$prev" ] && [ -d "$prev" ]; then
    echo "rolling back to $prev" >&2
    $SUDO ln -sfn "$prev" "$APP_DIR/current"
    $SUDO systemctl restart spendapp
  fi
  $SUDO journalctl -u spendapp -n 40 --no-pager >&2 || true
  exit 1
fi

# Best effort: split-horizon DNS or an outbound firewall can fail this even
# when the site is fine from outside, so it only warns.
if [ -n "${APP_ORIGIN:-}" ]; then
  curl -fsS -m 10 "$APP_ORIGIN/api/health" >/dev/null 2>&1 \
    || echo "note: $APP_ORIGIN/api/health not reachable from this host — check DNS and your web server" >&2
fi

say "prune"
live=$(readlink -f "$APP_DIR/current")
# shellcheck disable=SC2012
stale=$($SUDO ls -1d "$APP_DIR"/releases/*/ 2>/dev/null | sort | head -n "-$KEEP_RELEASES" || true)
for old in $stale; do
  if [ "$(readlink -f "$old")" != "$live" ]; then
    $SUDO rm -rf "$old"
  fi
done
# shellcheck disable=SC2012
old_backups=$($SUDO ls -1 "$SHARED"/backups/*.sql.gz 2>/dev/null | sort | head -n "-$KEEP_BACKUPS" || true)
[ -n "$old_backups" ] && $SUDO rm -f $old_backups

echo
echo "release $stamp ($sha) live at ${APP_ORIGIN:-http://127.0.0.1:$port}"
