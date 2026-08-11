import { describe, expect, it } from 'vitest';
import { usernameSchema } from '../src/schemas.js';

/**
 * The username rule is the one piece of validation whose *message* is part of
 * the product: registration cannot say much else about why it refused, so the
 * wording is pinned here alongside the rule itself.
 */
describe('usernameSchema', () => {
  const ok = (v: string) => usernameSchema.safeParse(v).success;

  it('takes plain handles of three to thirty-two characters', () => {
    expect(ok('abc')).toBe(true);
    expect(ok('lukas')).toBe(true);
    expect(ok('a'.repeat(32))).toBe(true);
  });

  it('refuses anything shorter than three or longer than thirty-two', () => {
    expect(ok('ab')).toBe(false);
    expect(ok('a'.repeat(33))).toBe(false);
  });

  it('allows . _ - and @ between the ends', () => {
    expect(ok('lukas.b')).toBe(true);
    expect(ok('lukas_b')).toBe(true);
    expect(ok('lukas-b')).toBe(true);
    // An email address is a perfectly good handle for somebody who wants one.
    // Nothing is sent to it and nothing about it is verified.
    expect(ok('lukas@example.com')).toBe(true);
  });

  it('refuses a separator at either end', () => {
    expect(ok('.lukas')).toBe(false);
    expect(ok('lukas-')).toBe(false);
    expect(ok('@lukas')).toBe(false);
  });

  it('refuses spaces and anything else', () => {
    expect(ok('lukas b')).toBe(false);
    expect(ok('lukas!')).toBe(false);
    expect(ok('lukas/b')).toBe(false);
  });

  it('is case-insensitive on input', () => {
    expect(ok('Lukas')).toBe(true);
  });

  it('names the field it is about, and calls the punctuation allowed rather than required', () => {
    const message = usernameSchema.safeParse('!').error!.issues[0]!.message;
    // Without the field name the reader has to guess which of three inputs a
    // rejected registration meant.
    expect(message).toMatch(/^Username:/);
    expect(message).toContain('Allowed special characters: . _ - @');
  });
});
