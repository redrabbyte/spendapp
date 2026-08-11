import { CATEGORIES } from '@spendapp/shared';
import type { MessageKey, Translator } from './index';

/**
 * A category's label in the reader's language.
 *
 * The stored value is the key ('food'), sealed inside the expense, so this is
 * display only — translating a label never rewrites what was written down.
 *
 * CSV import accepts any string (`import.ts` only caps the length), so a
 * category can perfectly well be one nobody wrote a translation for. That is
 * not an error: show what the file said rather than a raw message key.
 */
const KNOWN = new Set<string>(CATEGORIES);

export function categoryLabel(t: Translator, category: string): string {
  return KNOWN.has(category) ? t(`category.${category}` as MessageKey) : category;
}
