import { useCallback } from 'react';
import { formatMoney } from '@spendapp/shared';
import { useSettings } from '../settings';

/**
 * Money, written for the reader. Bound to the chosen language rather than the
 * browser's, so a German interface does not print "€12.34" because the phone
 * happens to be set to English.
 *
 * Display only. Anything a machine reads — the CSV export — or anything that
 * goes back into a number field keeps `formatMinor`.
 */
export function useMoney(): (amountMinor: number, currency: string) => string {
  const { settings } = useSettings();
  return useCallback(
    (amountMinor, currency) => formatMoney(amountMinor, currency, settings.language),
    [settings.language],
  );
}
