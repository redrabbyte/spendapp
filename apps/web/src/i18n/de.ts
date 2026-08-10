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

  // --- app shell ----------------------------------------------------------
  'sync.pending': 'Noch nicht synchronisiert — diese Änderung entstand offline und wird hochgeladen, sobald du wieder online bist.',

  'invalid.summary': {
    one: '{count} Eintrag geht nicht auf und bleibt aus allen Summen hier heraus.',
    other: '{count} Einträge gehen nicht auf und bleiben aus allen Summen hier heraus.',
  },
  'invalid.item': 'zuletzt bearbeitet von {author} — {reason}',
  'invalid.hint': 'Bitte sie, ihn zu öffnen und noch einmal zu speichern. Bis dahin fehlt den Summen der Gruppe genau dieser Betrag.',

  'push.unavailable': 'Push ist auf diesem Server nicht eingerichtet (keine VAPID-Schlüssel).',
  'push.unsupported': 'Auf iOS brauchen Benachrichtigungen eine installierte App: Teilen → „Zum Home-Bildschirm“.',
  'push.label': 'Benachrichtigungen:',
  'push.blocked': 'in den Browsereinstellungen blockiert',
  'push.on': 'an — ausschalten',
  'push.off': 'aus — einschalten',
  'push.prompt': 'Benachrichtigt werden, wenn jemand eine Ausgabe einträgt oder dir Geld zurückzahlt?',
  'push.prompt.enable': 'Einschalten',
  'push.prompt.later': 'Jetzt nicht',

  'gap.title': 'Es wird nur ein Teil dieser Gruppe angezeigt.',
  'gap.expenses': 'Einträge von vor deinem Beitritt werden hier nicht aufgeführt.',
  'gap.balances': 'Diese Salden umfassen nur, was du lesen kannst. Dein eigener Stand stimmt genau — du warst an keiner früheren Aufteilung beteiligt —, aber Schulden zwischen anderen von vor deinem Beitritt fehlen.',
  'gap.charts': 'Diese Auswertungen umfassen nur, was du lesen kannst; Summen und Kategorien beginnen also mit deinem Beitritt.',
  'gap.activity': 'Der Verlauf beginnt mit deinem Beitritt. Frühere Einträge, Kommentare und Belege werden nicht angezeigt.',
  'gap.members': 'Du bist erst später dazugekommen und kannst den vollen Verlauf dieser Gruppe deshalb nicht an neue Mitglieder weitergeben.',

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
