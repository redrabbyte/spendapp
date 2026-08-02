// Print DATABASE_URL's parts as shell assignments, for `eval "$(node dburl.mjs)"`.
// Keeps URL parsing (and percent-decoding of the password) out of shell.
const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}
const u = new URL(url);
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
process.stdout.write(
  [
    `DB_HOST=${q(u.hostname)}`,
    `DB_PORT=${q(u.port || '3306')}`,
    `DB_USER=${q(decodeURIComponent(u.username))}`,
    `DB_PASS=${q(decodeURIComponent(u.password))}`,
    `DB_NAME=${q(decodeURIComponent(u.pathname.replace(/^\//, '')))}`,
    '',
  ].join('\n'),
);
