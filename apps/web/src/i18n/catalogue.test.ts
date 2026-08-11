import { describe, expect, it } from 'vitest';
import { usernameSchema } from '@spendapp/shared';
import { de } from './de';
import { en } from './en';
import type { Message } from './index';

/**
 * The catalogues are edited by hand and by scripts, and neither the compiler
 * nor any test elsewhere reads what is actually *in* a message. Three things
 * can go wrong quietly and all of them reach a user:
 *
 * - text mangled by an encoding round trip, which is how two em dashes became
 *   "â" in this very file;
 * - a translation that drops a {placeholder}, leaving a sentence with a hole
 *   where the name or amount should be;
 * - a plural form declared in one language and not the other.
 */

const CATALOGUES = { en, de } as const;

const placeholders = (m: Message): string[] =>
  [...(typeof m === 'string' ? [m] : [m.one, m.other]).join(' ').matchAll(/\{(\w+)\}/g)]
    .map((x) => x[1]!)
    .sort();

const texts = (m: Message): string[] => (typeof m === 'string' ? [m] : [m.one, m.other]);

describe('message catalogues', () => {
  it.each(Object.entries(CATALOGUES))('%s holds no mangled text', (_name, catalogue) => {
    for (const [key, message] of Object.entries(catalogue as Record<string, Message>)) {
      for (const text of texts(message)) {
        // U+FFFD is what a decoder emits when it gives up; "Â" and "â" before
        // punctuation are the signature of UTF-8 read as latin-1.
        expect(text, key).not.toMatch(/�|Â|â(?![a-zà-ÿ])/);
        expect(text.trim(), key).not.toBe('');
      }
    }
  });

  it('translates every key without losing a placeholder', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(de[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('agrees on which messages have plural forms', () => {
    // German and English happen to share two plural categories. If they ever
    // disagree about whether a key needs them, one language silently loses its
    // count-sensitive wording.
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(typeof de[key], key).toBe(typeof (en[key] as Message));
    }
  });

  /**
   * The username rule lives in `packages/shared` and the sentence describing it
   * lives here, because only the client knows who is reading. Nothing else ties
   * the two together: widen the regex and both catalogues would go on listing
   * the old set, which is worse than saying nothing — the reader would rule out
   * a character the server would have taken.
   */
  it.each(Object.entries(CATALOGUES))('%s lists exactly the username characters the rule allows', (_n, catalogue) => {
    const sentence = catalogue['error.invalid_username'] as string;
    const accepts = (c: string) => usernameSchema.safeParse(`a${c}a`).success;
    for (const c of '.-_@+!#$%&*/\\ ,;:?~^|()[]{}<>"\'=') {
      expect(sentence.includes(` ${c}`), `${c} accepted=${accepts(c)}`).toBe(accepts(c));
    }
  });
});
