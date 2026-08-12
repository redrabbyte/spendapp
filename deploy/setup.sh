#!/usr/bin/env bash
#
# One-time provisioning. Run this on the server you are deploying to, from a
# checkout of this repository:
#
#   ./deploy/setup.sh https://spend.example.com
#
# Idempotent: re-run it to change the public URL, or after editing
# spendapp.service.
#
# Targets Debian/Ubuntu (apt). Installs Node, pnpm and MySQL if they are
# missing, creates the service user, database and shared state, and installs
# the systemd unit. It does not touch your web server — point that at the
# release root yourself (see deploy/README.md).
set -euo pipefail

ORIGIN=${1:-${SPENDAPP_ORIGIN:-}}
if [ -z "$ORIGIN" ]; then
  cat >&2 <<USAGE
usage: $0 <public-url>

  <public-url>  the origin the app is served from, e.g. https://spend.example.com
                It becomes APP_ORIGIN, which deploy.sh health-checks after
                each release. The app itself does not read it — the session
                cookie is __Host- prefixed and scoped to whatever host serves
                it, so it needs no configuring.
                Must be https: the camera used for in-person joins needs a
                secure context, and __Host- cookies require one.

env: SPENDAPP_DIR (default /opt/spendapp)
USAGE
  exit 64
fi

case "$ORIGIN" in
  https://*) ;;
  http://*) echo "warning: $ORIGIN is not https — the service worker, install prompt and push will not work" >&2 ;;
  *) echo "error: <public-url> must start with https:// or http://" >&2; exit 64 ;;
esac

APP_DIR=${SPENDAPP_DIR:-/opt/spendapp}
SHARED="$APP_DIR/shared"
DOMAIN=${ORIGIN#*://}
DOMAIN=${DOMAIN%%/*}
SERVICE_USER=spendapp
DB_NAME=spendapp
DB_USER=spendapp

REPO=$(cd "$(dirname "$0")/.." && pwd)

SUDO=''
[ "$(id -u)" -ne 0 ] && SUDO=sudo

command -v apt-get >/dev/null || {
  echo "This script targets Debian/Ubuntu. Install git, Node >= 22.13, pnpm and" >&2
  echo "MySQL 8 by hand, then run deploy/deploy.sh." >&2
  exit 1
}

say() { printf '\n== %s\n' "$*"; }

say "packages"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq git curl ca-certificates gnupg

# Node >= 22.13 — required by pnpm 11.
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
node_minor=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 13 ]; }; then
  say "installing Node 22"
  # -E is a sudo flag, so it must drop out along with $SUDO when run as root.
  # shellcheck disable=SC2086
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO ${SUDO:+-E} bash -
  $SUDO apt-get install -y -qq nodejs
fi

if ! command -v pnpm >/dev/null; then
  say "installing pnpm"
  $SUDO corepack enable
  $SUDO corepack prepare pnpm@11.21.0 --activate
fi

if ! command -v mysqld >/dev/null && ! command -v mariadbd >/dev/null; then
  say "installing MySQL"
  $SUDO apt-get install -y -qq mysql-server
  $SUDO systemctl enable --now mysql
fi

say "service user and directories"
id -u "$SERVICE_USER" >/dev/null 2>&1 || $SUDO useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
$SUDO mkdir -p "$APP_DIR/releases" "$SHARED/receipts" "$SHARED/backups"

$SUDO chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
# The web server runs as its own user and serves the built files from here.
$SUDO chmod 755 "$APP_DIR" "$APP_DIR/releases"

if [ ! -f "$SHARED/.env" ]; then
  say "database and .env"
  db_pass=$(openssl rand -hex 24)
  decoy_secret=$(openssl rand -hex 32)
  $SUDO mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$db_pass';
ALTER USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$db_pass';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
  $SUDO tee "$SHARED/.env" >/dev/null <<ENV
DATABASE_URL=mysql://$DB_USER:$db_pass@127.0.0.1:3306/$DB_NAME
PORT=3000
# Behind HTTPS: enables the __Host- session cookie.
COOKIE_SECURE=1
RECEIPTS_DIR=$SHARED/receipts
PRIVACY_PATH=$SHARED/privacy.md
APP_ORIGIN=$ORIGIN
# Every proxy between a client and the API, innermost first. See deploy/README.md.
TRUSTED_PROXIES=loopback
# Keys the fake KDF salt for usernames that do not exist. Secret, or decoys can
# be recomputed offline and /api/auth/params enumerates accounts again.
AUTH_DECOY_SECRET=$decoy_secret

# VAPID keys are generated on the first release if absent.
VAPID_SUBJECT=mailto:admin@$DOMAIN
ENV
  $SUDO chown "$SERVICE_USER:$SERVICE_USER" "$SHARED/.env"
  $SUDO chmod 600 "$SHARED/.env"
  echo "wrote $SHARED/.env with a generated database password"
else
  # Keep the password and keys; only re-point the origin.
  current_origin=$($SUDO grep -m1 '^APP_ORIGIN=' "$SHARED/.env" | cut -d= -f2- || true)
  if [ "$current_origin" != "$ORIGIN" ]; then
    $SUDO sed -i "s|^APP_ORIGIN=.*|APP_ORIGIN=$ORIGIN|" "$SHARED/.env"
    echo "updated APP_ORIGIN: ${current_origin:-unset} -> $ORIGIN"
  else
    echo "$SHARED/.env exists and already points at $ORIGIN — left alone"
  fi
  # Added after the first releases, so an existing .env will not have it.
  if ! $SUDO grep -q '^PRIVACY_PATH=' "$SHARED/.env"; then
    echo "PRIVACY_PATH=$SHARED/privacy.md" | $SUDO tee -a "$SHARED/.env" >/dev/null
    echo "added PRIVACY_PATH=$SHARED/privacy.md"
  fi
  # Loopback is the safe floor — one web server on this host. Further hops by hand.
  if ! $SUDO grep -q '^TRUSTED_PROXIES=' "$SHARED/.env"; then
    echo "TRUSTED_PROXIES=loopback" | $SUDO tee -a "$SHARED/.env" >/dev/null
    echo "added TRUSTED_PROXIES=loopback — add any further hops by hand"
  fi
  # The server refuses to start in production without this, so generate one
  # rather than leave an existing deployment unable to boot.
  if ! $SUDO grep -q '^AUTH_DECOY_SECRET=' "$SHARED/.env"; then
    echo "AUTH_DECOY_SECRET=$(openssl rand -hex 32)" | $SUDO tee -a "$SHARED/.env" >/dev/null
    echo "added AUTH_DECOY_SECRET"
  fi
fi

say "systemd unit"
sed -e "s|__APP_DIR__|$APP_DIR|g" "$REPO/deploy/spendapp.service" \
  | $SUDO tee /etc/systemd/system/spendapp.service >/dev/null
$SUDO chmod 644 /etc/systemd/system/spendapp.service
$SUDO systemctl daemon-reload
$SUDO systemctl enable spendapp

# .env is read once at startup, so anything changed above is still stale in the
# running process. Only meaningful once a release exists — before the first
# deploy there is nothing behind `current` to start.
if [ -e "$APP_DIR/current" ]; then
  if $SUDO systemctl restart spendapp; then
    echo "restarted spendapp — the current .env is live"
  else
    echo "warning: spendapp did not restart; check 'systemctl status spendapp'" >&2
  fi
else
  echo "no release yet — deploy.sh will start the service"
fi

port=$($SUDO grep -m1 '^PORT=' "$SHARED/.env" | cut -d= -f2- || true)

cat <<DONE

Provisioned for $ORIGIN.

Write your privacy policy to $SHARED/privacy.md before letting anyone
else sign up — apps/server/privacy.example.md says what it has to cover, and
the app picks the file up without a rebuild. Until it exists, registration
shows a placeholder that says so, and nobody is asked to re-consent.

Build and activate the first release:

  ./deploy/deploy.sh

Then point your web server at it. It needs to serve $DOMAIN over HTTPS and:

  root          $APP_DIR/current/apps/web/dist
  SPA fallback  unmatched paths -> /index.html
  proxy         /api/* -> 127.0.0.1:${port:-3000}

deploy/README.md has Caddy and nginx examples. Nothing here manages your web
server, so the release directory is the only thing it has to follow — the
'current' symlink always points at the live one.
DONE
