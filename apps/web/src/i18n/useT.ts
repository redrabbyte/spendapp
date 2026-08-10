import { useCallback } from 'react';
import { useSettings } from '../settings';
import { translate, type Translator } from './index';

/**
 * The translator for the language currently selected. A hook rather than a
 * module-level function so that changing the language re-renders everything
 * that shows text, which is the whole app.
 */
export function useT(): Translator {
  const { settings } = useSettings();
  return useCallback((key, options) => translate(settings.language, key, options), [settings.language]);
}

/** The BCP 47 tag to hand to Intl, for money and dates. */
export function useLocale(): string {
  return useSettings().settings.language;
}
