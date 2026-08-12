# Deployment

## Upgrading from the unencrypted version: start fresh

This release is not an upgrade of the previous one. Everything a group holds is
now encrypted with keys derived from each member's password, and the server has
no way to read the old rows and no way to produce the keys that would re-seal
them — nobody has them but the users, and only while typing their password. So
there is no migration path, and pretending to offer one would mean shipping a
step that could only ever fail halfway.

The schema ships as a single baseline rather than a chain of alterations, for
the same reason: there is no old database it could be applied to.

Wipe the old install first. Four things hold state, and missing any one of them
leaves you with an install that only looks fresh:

```sh
# Keep the one file that is not in the repo and cannot be regenerated
sudo cp /opt/spendapp/shared/privacy.md ~/privacy.md

sudo systemctl disable --now spendapp
sudo rm -f /etc/systemd/system/spendapp.service
sudo systemctl daemon-reload

# The database *and* the user. setup.sh uses CREATE DATABASE IF NOT EXISTS, so
# skipping this gives you a new .env and password pointed at all the old data.
sudo mysql <<'SQL'
DROP DATABASE IF EXISTS spendapp;
DROP USER IF EXISTS 'spendapp'@'127.0.0.1';
SQL

# Releases, .env, VAPID keys, receipt files, backups, privacy.md
sudo rm -rf /opt/spendapp
```

Then `./deploy/setup.sh https://…` and `./deploy/deploy.sh` build it from
nothing. New VAPID keys mean every existing push subscription is dead, which is
moot: the accounts are gone too.

**Tell people to clear the site data.** Server-side teardown does not reach
anyone's browser. On the same origin a returning user still has a registered
service worker, a cached app shell, and an IndexedDB holding their decrypted
mirror and their account keys — so they will see a group that no longer exists
and be unable to log in to it. Clearing site data, or uninstalling and
reinstalling the PWA, is what actually resets them.

Both scripts run **on the server you are deploying to**, from a checkout of
this repository. They manage the API service and the built PWA; serving them
to the internet is left to whatever web server the host already runs.

## First deploy

```sh
git clone <this-repo> spendapp && cd spendapp
./deploy/setup.sh https://spend.example.com
./deploy/deploy.sh
```

The public URL is a parameter of `setup.sh`. It becomes `APP_ORIGIN`, which
`deploy.sh` reads back out of the shared `.env` to health-check the release it
just activated. Nothing in the app reads it: the session cookie is `__Host-`
prefixed, which the browser scopes to whichever host served it, so there is no
origin to configure and no way to get it wrong.

It has to be `https` for reasons that are not about `APP_ORIGIN` at all —
`__Host-` cookies require a secure context, and so does the camera used for
the in-person QR join.

`setup.sh` targets Debian/Ubuntu and is idempotent — re-run it to change the
public URL, or after editing `spendapp.service`. It generates the database
password and writes `shared/.env` on first run; later runs only re-point
`APP_ORIGIN`, add `PRIVACY_PATH` if an older `.env` lacks it, and restart the
service so the file it just edited is actually in effect. Everything else in
that file is left alone — the database password, the VAPID keys, and any value
you have edited by hand, including `VAPID_SUBJECT`. VAPID keys for push are
generated on the first release if the file has none.

Changing the public URL logs everybody out and empties their local copy:
browser storage is per-origin, so on a new host the session cookie does not
apply and the offline mirror — which holds the decrypted ledger and the cached
account keys — starts empty. Nothing is lost server-side, but every user
re-enters their password, and anyone who installed the PWA installs it again.

## Wiring up a web server

Nothing in `deploy/` installs or configures one. Point the host's existing
web server at the release root — the `current` symlink always resolves to the
live release, so the configuration never needs to change again:

| | |
|---|---|
| root | `/opt/spendapp/current/apps/web/dist` |
| SPA fallback | unmatched paths → `/index.html` |
| proxy | `/api/*` → `127.0.0.1:3000` |

HTTPS is required — the service worker, install prompt and push all need a
secure context, and `COOKIE_SECURE=1` sets a `__Host-` cookie.

**`TRUSTED_PROXIES` has to list every hop**, innermost first. The rate limiter
keys on the rightmost `X-Forwarded-For` entry that is not one of them, so both
directions break it: a hop missing puts every client in one shared bucket, and
listing something you do not control lets a client pick its own bucket.

Default is `loopback` — one web server on this host. A Caddy in an LXC
container behind the host's Caddy is `loopback,10.10.10.1`. Confirm rather than
assume:

```sh
sudo timeout 10 tcpdump -i lo -A -s0 'tcp port 3000' | grep -i x-forwarded-for
```

Every entry but the leftmost was written by a proxy; list those. The front proxy
must *replace* an inbound `X-Forwarded-For`, not append — Caddy does this for
clients outside its own `trusted_proxies`.

Two details worth getting right: hashed bundles under `/assets/` can be
cached forever, but `index.html` and `sw.js` must be revalidated or clients
will never see a new release.

**Leave the access log off.** The API deliberately records no client address
and puts no username in a URL, so its own log is close to anonymous. A web
server access log in front of it undoes that in one line: it pairs an IP with
the request path, which makes it personal data, which puts it in scope for
every subject access request for as long as it is kept. Caddy writes no access
log unless you ask for one; nginx does by default, hence `access_log off`
below. If you do want one, give it a short retention and say so in your privacy
policy — and note that a Caddy `log` writing to a file rotates on Caddy's own
schedule (90 days by default), not the system journal's.

Caddy:

```caddy
spend.example.com {
	encode zstd gzip
	root * /opt/spendapp/current/apps/web/dist

	handle /api/* {
		reverse_proxy 127.0.0.1:3000
	}

	handle {
		@immutable path /assets/*
		header @immutable Cache-Control "public, max-age=31536000, immutable"
		@revalidate path / /index.html /sw.js /manifest.webmanifest
		header @revalidate Cache-Control "no-cache"

		try_files {path} /index.html
		file_server
	}
}
```

nginx:

```nginx
server {
	server_name spend.example.com;
	root /opt/spendapp/current/apps/web/dist;
	access_log off;

	location /api/ { proxy_pass http://127.0.0.1:3000; }
	location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }
	location = /sw.js { add_header Cache-Control "no-cache"; }
	location / { try_files $uri /index.html; }
}
```

The API sets its own security headers, so don't override them on `/api/*`.

## Layout on the host

```
/opt/spendapp/
  releases/<utc-stamp>/     # one exported commit each
  current -> releases/…     # flipped atomically at the end of a deploy
  shared/
    .env                    # secrets and APP_ORIGIN; survives releases
    privacy.md              # PRIVACY_PATH; write it, it is not in the repo
    receipts/               # RECEIPTS_DIR
    backups/                # pre-migration mysqldumps
```

Override the root with `SPENDAPP_DIR`.

## The privacy policy

`shared/privacy.md` is shown on the signup form and has to be accepted before
an account is created. It is deliberately not in the repository — it is
deployment text, it changes on its own clock, and it may name people. Write it
before letting anyone but yourself sign up; `apps/server/privacy.example.md`
lists what it needs to cover. It is read from disk, so editing it takes effect
without a rebuild or a restart.

Until the file exists the app serves that placeholder instead, and says on the
form that no policy is installed. Nobody is asked to re-consent to it: only a
real policy interrupts existing accounts.

Changing the policy later asks everyone to accept it again, which is what the
`<!-- version: … -->` marker on the first line controls — bump it for a
substantive change, leave it alone for a typo. Without a marker every edit
counts, since the version becomes a hash of the file.

## Deleting an account for someone

People delete their own accounts from Settings, which asks for the password
again. That is no help to the person most likely to be asking you: whoever lost
their password, and with it the ability to decrypt anything. The privacy notice
says such a request can be made by email, so there is a script:

```sh
cd /opt/spendapp/current/apps/server
sudo -u spendapp pnpm --filter server delete-account <username>
```

It prints what will be destroyed — groups that die with them, admin succession,
history that becomes unreadable for good — and waits for the username to be
typed back. It runs the same erasure the app's own delete button does, so there
is one implementation and no chance of the two drifting apart.

Run it from the release directory: it reads `DATABASE_URL` from the shared
`.env` the same way the service does.

## Every deploy

```sh
git pull && ./deploy/deploy.sh
```

1. `git archive HEAD` into a new release directory.
2. `pnpm install --frozen-lockfile` and `pnpm --filter web build`.
3. `mysqldump` into `shared/backups/` — **before** migrations touch anything.
4. `pnpm --filter server db:migrate`.
5. Flip `current`, restart the unit, health-check `127.0.0.1:3000/api/health`.
   A failed check rolls the symlink back and dumps the last 40 journal lines.
   The public origin is then checked too, but only warns — that one depends
   on the web server, which these scripts do not manage.
6. Prune to the last 5 releases and 10 backups.

Deploying a specific commit or tag:

```sh
SPENDAPP_REF=v1.2.0 ./deploy/deploy.sh
```

## Operating

```sh
systemctl status spendapp
journalctl -u spendapp -f
ls /opt/spendapp/releases
```

Roll back to the previous release:

```sh
ln -sfn /opt/spendapp/releases/<stamp> /opt/spendapp/current
systemctl restart spendapp
```

That reverts code only. If the release ran a migration, restore the matching
dump from `shared/backups/` as well:

```sh
gunzip -c /opt/spendapp/shared/backups/<stamp>.sql.gz \
  | mysql -h127.0.0.1 -uspendapp -p spendapp
```

A restored dump is ciphertext without the members' passwords, so a backup is
only half a recovery plan — see the encryption notes in the top-level README.
There is no longer an activity-log rebuild: those snapshots held plaintext and
went with it.
