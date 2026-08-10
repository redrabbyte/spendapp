import type { Catalogue } from './index';

/**
 * German. Addresses the reader as "du" throughout: this is an app for
 * splitting dinner with friends, and "Sie" would be wrong in every screen it
 * appears on.
 */
export const de: Catalogue = {
  // --- settings -----------------------------------------------------------
  'settings.title': 'Einstellungen',
  'settings.close': 'Schließen',
  'settings.appearance': 'Darstellung',
  'settings.theme.system': 'System',
  'settings.theme.light': 'hell',
  'settings.theme.dark': 'dunkel',
  'settings.language': 'Sprache',
  'settings.currency': 'Meine Standardwährung',
  'settings.currency.hint': 'Vorausgewählt, wenn du eine neue Gruppe anlegst.',
  'settings.timezone': 'Angezeigte Zeitzone',
  'settings.timezone.device': 'Gerät ({zone})',
  'settings.timezone.choose': 'auswählen…',
  'settings.timezone.filter': 'Zeitzonen filtern…',
  'settings.timezone.hint': 'Zeiten werden in UTC gespeichert und in dieser Zone angezeigt.',
  'settings.notifications': 'Benachrichtigungen',
};
