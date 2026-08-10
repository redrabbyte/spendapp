import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { currentPolicy } from './privacy.js';

/**
 * `installed` decides whether existing accounts are interrupted to re-consent,
 * so getting it wrong either nags a whole userbase about placeholder text or
 * never asks them about the real thing. Both failures are silent.
 */

const dir = mkdtempSync(join(tmpdir(), 'privacy-'));
const original = config.privacyPath;
let n = 0;

/** A fresh filename each time: currentPolicy caches on path + mtime. */
function serve(text: string): void {
  const path = join(dir, `policy-${n++}.md`);
  writeFileSync(path, text);
  config.privacyPath = path;
}

afterEach(() => {
  config.privacyPath = original;
});

describe('currentPolicy', () => {
  it('falls back to the placeholder when the file is missing', () => {
    config.privacyPath = join(dir, 'definitely-not-here.md');
    const policy = currentPolicy();
    expect(policy.installed).toBe(false);
    expect(policy.version).toBe('placeholder');
    expect(policy.text).toContain('This is not a privacy policy');
  });

  it('still reports not-installed for a verbatim copy of the placeholder', () => {
    // Copying the example and forgetting to write the real thing is the likely
    // mistake; a file existing is not evidence that anyone wrote a policy.
    serve('<!-- version: placeholder -->\n# Whatever\n');
    expect(currentPolicy().installed).toBe(false);
  });

  it('takes the version from the marker, so a typo fix does not re-prompt', () => {
    serve('<!-- version: 2026-08-10 -->\n# Privacy\n\nWe keep very little.\n');
    const first = currentPolicy();
    expect(first).toMatchObject({ installed: true, version: '2026-08-10' });

    serve('<!-- version: 2026-08-10 -->\n# Privacy\n\nWe keep very litle.\n');
    expect(currentPolicy().version).toBe('2026-08-10');
  });

  it('hashes the text when there is no marker, so any edit re-prompts', () => {
    serve('# Privacy\n\nWe keep very little.\n');
    const first = currentPolicy();
    expect(first.installed).toBe(true);
    expect(first.version).toMatch(/^sha256:[0-9a-f]{16}$/);

    serve('# Privacy\n\nWe keep very little indeed.\n');
    expect(currentPolicy().version).not.toBe(first.version);
  });
});
