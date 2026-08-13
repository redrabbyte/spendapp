# Deployment

`deploy/setup.sh` and `deploy/deploy.sh` run **on the server being deployed
to**, from a checkout of this repository. They manage the API service and the
built PWA; serving those to the internet is left to whatever web server the
host already runs.

## First deploy

```sh
git clone <this-repo> spendapp && cd spendapp
./deploy/setup.sh https://spend.example.com   # once: provision the host
./deploy/deploy.sh                            # build and activate a release
```

`setup.sh` targets Debian/Ubuntu and is idempotent — re-run it to change the
public URL, or after editing `spendapp.service`. The first run installs Node,
pnpm and MySQL if they are missing, creates the `spendapp` service user, the
database and the shared state directories, generates the database password and
writes `shared/.env`, and installs the systemd unit. Later runs re-point
`APP_ORIGIN`, fill in any of `PRIVACY_PATH`, `TRUSTED_PROXIES` and
`AUTH_DECOY_SECRET` that `shared/.env` is missing, reinstall the unit, and
restart the service so the edited file takes effect. Everything else in that
file is left alone: the database password, the VAPID keys, and any value edited
by hand. VAPID keys for push are generated on the first release if the file has
none.

The public URL is a parameter of `setup.sh`. It becomes `APP_ORIGIN`, which
`deploy.sh` reads back out of the shared `.env` to health-check the release it
just activated. Nothing in the app reads it: the session cookie is `__Host-`
prefixed, which the browser scopes to whichever host served it, so there is no
origin to configure and no way to get it wrong.

It has to be `https` for reasons that are not about `APP_ORIGIN` at all —
`__Host-` cookies require a secure context, and so does the camera used for the
in-person QR join.

Changing the public URL later logs everybody out and empties every local copy.
Browser storage is per-origin, so on a new host the session cookie does not
apply and the offline mirror — which holds the decrypted ledger and the cached
account keys — starts empty. Nothing is lost server-side, but every member
re-enters their password, and anyone who installed the PWA installs it again.

## Wiring up a web server

Nothing in `deploy/` installs or configures one. Point the host's existing web
server at the release root — the `current` symlink always resolves to the live
release, so the configuration never needs to change again:

| | |
|---|---|
| root | `/opt/spendapp/current/apps/web/dist` |
| SPA fallback | unmatched paths → `/index.html` |
| proxy | `/api/*` → `127.0.0.1:3000` |

HTTPS is required — the service worker, install prompt and push all need a
secure context, and `COOKIE_SECURE=1` sets a `__Host-` cookie.

Hashed bundles under `/assets/` can be cached forever, but `index.html` and
`sw.js` must be revalidated or clients will never see a new release.

### Trusted proxies

**`TRUSTED_PROXIES` has to list every hop**, innermost first. The rate limiter
keys on the rightmost `X-Forwarded-For` entry that is not one of them, so both
directions break it: a hop missing puts every client in one shared bucket, and
listing something outside the deployment's control lets a client pick its own
bucket.

The default, `loopback`, covers one web server on this host. A Caddy in an LXC
container behind the host's Caddy is `loopback,10.10.10.1`. Confirm rather than
assume:

```sh
sudo timeout 10 tcpdump -i lo -A -s0 'tcp port 3000' | grep -i x-forwarded-for
```

Every entry but the leftmost was written by a proxy; list those. The front proxy
must *replace* an inbound `X-Forwarded-For`, not append — Caddy does this for
clients outside its own `trusted_proxies`.

### Security headers

**The security headers are the web server's to send.** This is the one part of
the configuration that is not optional, and the one it is easiest to leave out,
because leaving it out changes nothing visible. The API sets headers on its own
JSON responses, but a Content-Security-Policy constrains a *document*, and the
document is the file server's to serve — so `/api/*` headers protect nothing
that executes. The page holds the decrypted ledger, the account key and the
group keys in memory, and this policy is what stops injected script from taking
them.

The build injects the same policy into `index.html` as a `<meta>` tag, so a
misconfigured web server is not a total loss. The headers are still required: a
meta tag cannot carry `frame-ancestors` (browsers ignore it there), so without
them the app can be framed and clickjacked, and HSTS and `nosniff` never reach
the assets at all. The policy must stay identical to
`apps/web/src/documentPolicy.ts` — `apps/web/src/documentPolicy.test.ts` fails
if the two drift apart.

### Access logging

**Leave the access log off.** The API deliberately records no client address
and puts no username in a URL, so its own log is close to anonymous. A web
server access log in front of it undoes that in one line: it pairs an IP with
the request path, which makes it personal data, which puts it in scope for
every subject access request for as long as it is kept. Caddy writes no access
log unless one is configured; nginx does by default, hence `access_log off`
below. A log that is kept anyway needs a short retention and a mention in the
privacy policy — and note that a Caddy `log` writing to a file rotates on
Caddy's own schedule (90 days by default), not the system journal's.

### Caddy

```caddy
spend.example.com {
	encode zstd gzip
	root * /opt/spendapp/current/apps/web/dist

	handle /api/* {
		reverse_proxy 127.0.0.1:3000
	}

	handle {
		header {
			Content-Security-Policy "default-src 'self'; base-uri 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self'; form-action 'self'; worker-src 'self'; manifest-src 'self'; font-src 'self'; frame-src 'none'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests; frame-ancestors 'none'"
			X-Frame-Options "DENY"
			X-Content-Type-Options "nosniff"
			Referrer-Policy "no-referrer"
			Permissions-Policy "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=()"
			Strict-Transport-Security "max-age=31536000; includeSubDomains"
			Cross-Origin-Opener-Policy "same-origin"
			Cross-Origin-Resource-Policy "same-origin"
		}

		@immutable path /assets/*
		header @immutable Cache-Control "public, max-age=31536000, immutable"
		@revalidate path / /index.html /sw.js /manifest.webmanifest
		header @revalidate Cache-Control "no-cache"

		try_files {path} /index.html
		file_server
	}
}
```

### nginx

The headers go in their own file because `add_header` does not inherit into a
`location` that sets one of its own — the asset and `sw.js` blocks below both
do, and would silently lose every header set above them:

```nginx
# /etc/nginx/snippets/spendapp-security.conf
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self'; form-action 'self'; worker-src 'self'; manifest-src 'self'; font-src 'self'; frame-src 'none'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests; frame-ancestors 'none'" always;
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=()" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
```

```nginx
server {
	server_name spend.example.com;
	root /opt/spendapp/current/apps/web/dist;
	access_log off;

	location /api/ { proxy_pass http://127.0.0.1:3000; }
	location /assets/ {
		include snippets/spendapp-security.conf;
		add_header Cache-Control "public, max-age=31536000, immutable" always;
	}
	location = /sw.js {
		include snippets/spendapp-security.conf;
		add_header Cache-Control "no-cache" always;
	}
	location / {
		include snippets/spendapp-security.conf;
		try_files $uri /index.html;
	}
}
```

Headers do not belong on `/api/*` — the API sets its own there, and a second
`Content-Security-Policy` on a response is intersected with the first, not
replaced, so an addition can only ever tighten it into breakage.

Check the headers landed, on the document rather than on the API:

```sh
curl -sI https://spend.example.com/ | grep -i 'content-security-policy\|x-frame-options\|strict-transport'
```

## Layout on the host

```
/opt/spendapp/
  releases/<utc-stamp>/     # one exported commit each
  current -> releases/…     # flipped atomically at the end of a deploy
  shared/
    .env                    # secrets and APP_ORIGIN; survives releases
    privacy.md              # PRIVACY_PATH; not in the repo, see below
    receipts/               # RECEIPTS_DIR
    backups/                # pre-migration mysqldumps
```

`SPENDAPP_DIR` overrides the root.

## The privacy policy

`shared/privacy.md` is shown on the signup form and has to be accepted before
an account is created. It is deliberately not in the repository — it is
deployment text, it changes on its own clock, and it may name people. It has to
exist before anyone other than the operator signs up;
`apps/server/privacy.example.md` lists what it needs to cover. It is read from
disk, so editing it takes effect without a rebuild or a restart.

Until the file exists the app serves that example as a placeholder and says on
the form that no policy is installed. Only a real policy interrupts existing
accounts to ask for consent.

Changing the policy later asks everyone to accept it again, which is what the
`<!-- version: … -->` marker on the first line controls — bump it for a
substantive change, leave it alone for a typo. Without a marker every edit
counts, since the version becomes a hash of the file.

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
   The public origin is then checked too, but only warns — that one depends on
   the web server, which these scripts do not manage.
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

Rolling back to a previous release:

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

## Deleting an account on request

Members delete their own accounts from Settings. When a request arrives by
email instead — the route the privacy notice offers — run:

```sh
cd /opt/spendapp/current/apps/server
sudo -u spendapp pnpm --filter server delete-account <username>
```

It prints what will be destroyed — groups that die with the account, admin
succession, history that becomes unreadable for good — and waits for the
username to be typed back. It runs the same erasure as the app's own delete
button, so there is one implementation and no chance of the two drifting apart.

Run it from the release directory: it reads `DATABASE_URL` from the shared
`.env` the same way the service does.
