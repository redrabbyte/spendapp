import { en } from './en';
import { de } from './de';

/**
 * Translation, hand-rolled.
 *
 * A library would bring an ICU parser, a resource loader, namespaces and a
 * React integration. What this app needs is a lookup, one interpolation form
 * and correct plurals — about sixty lines, against forty kilobytes on a PWA
 * that people install on old phones. `Intl.PluralRules` does the only hard
 * part, and it is already in every browser this app supports.
 *
 * The English catalogue is the source of truth: its keys type every other
 * language, so a missing or misspelled German key fails to compile rather than
 * appearing as a raw key in front of somebody.
 */

export const LANGUAGES = { en: 'English', de: 'Deutsch' } as const;
export type Language = keyof typeof LANGUAGES;

/** Every message, or a plural form set. Values interpolate {name} placeholders. */
export type Plural = { one: string; other: string };
export type Message = string | Plural;
export type MessageKey = keyof typeof en;
/**
 * Values widen to `Message` rather than staying string literals: a key that is
 * a plain string in English may still need plural forms in another language,
 * and the lookup has to be able to see both shapes.
 */
export type Catalogue = Record<MessageKey, Message>;

const CATALOGUES: Record<Language, Catalogue> = { en, de };

export const isLanguage = (v: unknown): v is Language =>
  typeof v === 'string' && Object.hasOwn(LANGUAGES, v);

/**
 * What the browser asks for, narrowed to what exists. `navigator.languages` is
 * ordered by preference, so "de-AT, de, en" picks German rather than falling
 * through to the default on the regional tag.
 */
export function detectLanguage(): Language {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.split('-')[0]?.toLowerCase();
    if (isLanguage(base)) return base;
  }
  return 'en';
}

export interface TranslateOptions {
  /** Chooses the plural form, and is available as {count}. */
  count?: number;
  [name: string]: string | number | undefined;
}

const interpolate = (template: string, values: TranslateOptions): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    // A missing value is a bug in the call site, not something to hide behind
    // an empty string — leaving the placeholder visible makes it findable.
    return value === undefined ? whole : String(value);
  });

/**
 * Look a message up. Falls back to English for a key a translation is missing,
 * which cannot happen while the types hold but can when a catalogue is edited
 * by hand.
 */
export function translate(language: Language, key: MessageKey, options: TranslateOptions = {}): string {
  const message: Message = CATALOGUES[language][key] ?? en[key];
  if (typeof message === 'string') return interpolate(message, options);

  // English and German share the same two categories, but asking Intl rather
  // than testing `count === 1` is what keeps this correct if a third language
  // with more forms is ever added.
  const form = new Intl.PluralRules(language).select(options.count ?? 0);
  const text = form === 'one' ? message.one : message.other;
  return interpolate(text, options);
}

export type Translator = (key: MessageKey, options?: TranslateOptions) => string;
