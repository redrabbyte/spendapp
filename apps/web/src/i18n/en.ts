import type { Message } from './index';

/**
 * The source-of-truth catalogue. Its keys type every other language, so a
 * German file that misses one or misspells one fails to compile.
 *
 * Keys are namespaced by where they appear. Prose is kept whole rather than
 * assembled from fragments — a sentence split across three keys cannot be
 * translated into a language that orders its clauses differently.
 */
export const en = {
  // --- settings -----------------------------------------------------------
  'settings.title': 'Settings',
  'settings.close': 'Close',
  'settings.appearance': 'Appearance',
  'settings.theme.system': 'system',
  'settings.theme.light': 'light',
  'settings.theme.dark': 'dark',
  'settings.language': 'Language',
  'settings.currency': 'My default currency',
  'settings.currency.hint': 'Pre-selected when you create a new group.',
  'settings.timezone': 'Display timezone',
  'settings.timezone.device': 'device ({zone})',
  'settings.timezone.choose': 'choose…',
  'settings.timezone.filter': 'filter zones…',
  'settings.timezone.hint': 'Times are stored in UTC and shown in this zone.',
  'settings.notifications': 'Notifications',
} satisfies Record<string, Message>;
