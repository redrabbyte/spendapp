import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API_ERRORS } from '@spendapp/shared';
import { describe, expect, it } from 'vitest';

/**
 * Error bodies are user-facing copy delivered by the API, and the client can
 * only translate a code it knows. A handler inventing one — or leaving English
 * prose behind — puts an untranslated string, or a raw slug, in front of
 * somebody in the middle of a German interface. Neither fails anything else.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

function serverSource(): string {
  const read = (dir: string): string =>
    readdirSync(dir, { withFileTypes: true })
      .map((e) => {
        const path = `${dir}/${e.name}`;
        if (e.isDirectory()) return read(path);
        return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? readFileSync(path, 'utf8') : '';
      })
      .join('\n');
  return read(SRC);
}

/**
 * Every code the server can send: the `error: '…'` literals a handler writes
 * directly, and the ones an `ApiError` carries for the error handler to send.
 * Both have to be counted, or moving a handler to a thrown ApiError would look
 * like the code went dead.
 */
function sentCodes(): string[] {
  const src = serverSource();
  const found = [
    ...[...src.matchAll(/\berror: '([^']*)'/g)].map((m) => m[1]!),
    ...[...src.matchAll(/\bnew ApiError\(\s*'([^']*)'/g)].map((m) => m[1]!),
  ];
  return [...new Set(found)].sort();
}

describe('API error bodies', () => {
  it('sends only codes the client can translate', () => {
    const unknown = sentCodes().filter((code) => !(API_ERRORS as readonly string[]).includes(code));
    expect(unknown).toEqual([]);
  });

  it('sends no English prose', () => {
    // A code is lower_snake_case. Anything with a space or a capital is a
    // sentence that escaped, and would reach the user untranslated.
    expect(sentCodes().filter((code) => !/^[a-z][a-z0-9_]*$/.test(code))).toEqual([]);
  });

  it('declares no code the server never sends', () => {
    // A dead code is a message the client carries translations for and can
    // never show — harmless, but it means the list has stopped describing
    // what the API actually does.
    const sent = new Set(sentCodes());
    expect(API_ERRORS.filter((code) => !sent.has(code))).toEqual([]);
  });
});
