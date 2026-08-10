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

  // --- account ------------------------------------------------------------
  'account.title': 'Konto',
  'account.displayName': 'Dein Name',
  'account.displayName.hint': 'Das sehen alle in deinen Gruppen.',
  'account.username': 'Benutzername',
  'account.username.hint': 'Damit meldest du dich an. Eine Änderung wirkt sich nicht auf deine Daten aus.',
  'account.save': 'Änderungen speichern',
  'account.saving': 'Wird gespeichert…',
  'account.saved': 'Gespeichert.',

  // --- push -------------------------------------------------------------
  'push.expense.saved': '{actor} hat eine Ausgabe hinzugefügt oder geändert',
  'push.expense.deleted': '{actor} hat eine Ausgabe gelöscht',
  'push.payment.recorded': '{actor} hat eine Zahlung eingetragen',
  'push.comment.added': '{actor} hat eine Ausgabe kommentiert',
  'push.member.joined': '{actor} ist der Gruppe beigetreten',
  'push.member.left': '{actor} hat die Gruppe verlassen',
  'push.member.removed': '{actor} hat jemanden entfernt',
  'push.join.requested': '{actor} möchte beitreten',
  'push.join.approved': 'Deine Beitrittsanfrage wurde angenommen',
  'push.you.removed': 'Du wurdest aus {group} entfernt',
  'push.you.promoted': 'Du bist jetzt Admin',
  'push.you.promoted.lastAdminLeft': 'Du bist jetzt Admin — die letzte Person mit Adminrechten ist gegangen',

  // --- errors from the API ------------------------------------------------
  'error.unexpected': 'Etwas ist schiefgelaufen. Versuch es noch einmal.',
  'error.authentication_required': 'Du bist abgemeldet. Melde dich an und versuch es noch einmal.',
  'error.not_found': 'Das gibt es nicht mehr.',
  'error.invalid_input': 'Das sieht nicht richtig aus — prüf das Formular und versuch es noch einmal.',
  'error.client_update_required': 'Diese App ist veraltet. Lade die Seite neu, um sie zu aktualisieren.',
  'error.username_taken': 'Dieser Benutzername ist schon vergeben.',
  'error.invalid_credentials': 'Benutzername oder Passwort ist falsch.',
  'error.wrong_password': 'Falsches Passwort.',
  'error.no_such_account': 'Kein Konto mit diesem Namen.',
  'error.policy_changed': 'Die Datenschutzerklärung hat sich geändert, während du sie gelesen hast. Lade neu und lies sie noch einmal.',
  'error.not_a_member': 'Du bist nicht in dieser Gruppe.',
  'error.last_admin': 'Eine Gruppe braucht mindestens einen Admin.',
  'error.use_leave_to_remove_yourself': 'Nutze „Gruppe verlassen“, um dich selbst zu entfernen.',
  'error.no_pending_request': 'Diese Anfrage wartet nicht mehr.',
  'error.no_wraps_for_members': 'Niemandem konnte Zugriff gegeben werden — versuch es noch einmal.',
  'error.invite_invalid': 'Dieser Einladungslink gilt nicht mehr.',
  'error.invite_spent': 'Dieser Einladungslink wurde schon benutzt.',
  'error.join_declined': 'Deine Beitrittsanfrage wurde abgelehnt.',
  'error.attachment_missing': 'Dieser Beleg ist noch nicht fertig hochgeladen.',
};
