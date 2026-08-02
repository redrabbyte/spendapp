# Deployment

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
the `__Host-` session cookie and the Google Sign-In redirect URI depend on.
`deploy.sh` reads it back out of the shared `.env`.

`setup.sh` targets Debian/Ubuntu and is idempotent — re-run it to change the
public URL, or after editing `spendapp.service`. It generates the database
password and writes `shared/.env` on first run; later runs only re-point
`APP_ORIGIN` and leave the password and keys alone. VAPID keys for push are
generated on the first release if the file has none.

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

Two details worth getting right: hashed bundles under `/assets/` can be
cached forever, but `index.html` and `sw.js` must be revalidated or clients
will never see a new release.

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
    receipts/               # RECEIPTS_DIR
    backups/                # pre-migration mysqldumps
```

Override the root with `SPENDAPP_DIR`.

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

Expenses can also be rebuilt from the activity log without a dump — see the
recovery script in the top-level README.
