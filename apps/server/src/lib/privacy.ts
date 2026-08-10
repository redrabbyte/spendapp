import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

/**
 * The privacy policy, read from disk rather than compiled in.
 *
 * The real text is deliberately not in the repository: it is deployment
 * policy, it changes on a different clock from the code, and it may name
 * people. `PRIVACY_PATH` points at it (the deploy scripts put it in `shared/`
 * beside `.env`), so editing it takes effect without a rebuild.
 *
 * When that file is missing the committed placeholder is served instead. It
 * says plainly that it is not a policy — which is much better than an app that
 * silently registers people with no consent step at all.
 */

const FALLBACK = fileURLToPath(new URL('../../privacy.example.md', import.meta.url));

/**
 * The version marker the placeholder carries. Seeing it means the text is
 * still the placeholder even though a file exists — somebody copied the
 * example and has not written the real thing yet. `privacy.example.md` says
 * to change this line, and that is the whole contract.
 */
const PLACEHOLDER_VERSION = 'placeholder';

export interface Policy {
  text: string;
  /** What accounts store against their acceptance. */
  version: string;
  /** False when the placeholder is being served — a deployment mistake. */
  installed: boolean;
}

let cached: (Policy & { path: string; mtimeMs: number }) | null = null;

/**
 * Version comes from a marker on the first line if there is one, so an author
 * decides what counts as a substantive change and a typo fix does not ask
 * every account to re-consent. Without a marker it is a hash of the text,
 * which is the safe default: any edit at all becomes a new version.
 */
function versionOf(text: string): string {
  const marked = /^<!--\s*version:\s*(.+?)\s*-->/.exec(text);
  if (marked) return marked[1]!.slice(0, 64);
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

export function currentPolicy(): Policy {
  let path = config.privacyPath;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    path = FALLBACK;
    stat = statSync(path);
  }

  // Re-read only when the file actually changed: this is on the login path and
  // the answer is the same for everyone.
  if (cached && cached.path === path && cached.mtimeMs === stat.mtimeMs) {
    return { text: cached.text, version: cached.version, installed: cached.installed };
  }
  const text = readFileSync(path, 'utf8');
  const version = versionOf(text);
  cached = {
    text,
    version,
    installed: version !== PLACEHOLDER_VERSION,
    path,
    mtimeMs: stat.mtimeMs,
  };
  return { text, version, installed: cached.installed };
}
