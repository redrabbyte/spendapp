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

  // --- account ------------------------------------------------------------
  'account.title': 'Account',
  'account.displayName': 'Your name',
  'account.displayName.hint': 'This is what everyone in your groups sees.',
  'account.username': 'Username',
  'account.username.hint': 'What you log in with. Changing it does not affect your data.',
  'account.save': 'Save changes',
  'account.saving': 'Saving…',
  'account.saved': 'Saved.',

  // --- app shell ----------------------------------------------------------
  'sync.pending': 'Not synced yet â this change was made offline and will upload when you are back online.',

  'invalid.summary': {
    one: '{count} entry does not add up and is left out of every total here.',
    other: '{count} entries do not add up and are left out of every total here.',
  },
  'invalid.item': 'last written by {author} â {reason}',
  'invalid.hint': 'Ask them to open it and save it again. Until then the group’s totals are short by whatever it held.',

  'push.unavailable': 'Push is not configured on this server (no VAPID keys).',
  'push.unsupported': 'Notifications need an installed app on iOS: share → “Add to Home Screen”.',
  'push.label': 'Notifications:',
  'push.blocked': 'blocked in browser settings',
  'push.on': 'on — turn off',
  'push.off': 'off — turn on',
  'push.prompt': 'Get notified when someone adds an expense or pays you back?',
  'push.prompt.enable': 'Enable',
  'push.prompt.later': 'Not now',

  'gap.title': 'Showing only part of this group.',
  'gap.expenses': 'Entries written before you joined are not listed here.',
  'gap.balances': 'These balances cover only what you can read. Your own position is exact — you were in none of the earlier splits — but debts between other people from before you joined are not included.',
  'gap.charts': 'These charts cover only what you can read, so totals and categories start from when you joined.',
  'gap.activity': 'The history starts when you joined. Earlier entries, comments and receipts are not shown.',
  'gap.members': 'You joined partway through, so you cannot pass this group’s full history on to anyone new.',

  // --- push -------------------------------------------------------------
  // Written here rather than on the server, which has no idea who is reading.
  // Deliberately say nothing about the entry itself (design §3.3).
  'push.expense.saved': '{actor} added or changed an expense',
  'push.expense.deleted': '{actor} deleted an expense',
  'push.payment.recorded': '{actor} recorded a payment',
  'push.comment.added': '{actor} commented on an expense',
  'push.member.joined': '{actor} joined the group',
  'push.member.left': '{actor} left the group',
  'push.member.removed': '{actor} removed a member',
  'push.join.requested': '{actor} asked to join',
  'push.join.approved': 'Your request to join was approved',
  'push.you.removed': 'You were removed from {group}',
  'push.you.promoted': 'You are now an admin',
  'push.you.promoted.lastAdminLeft': 'You are now an admin — the last one left the group',

  // --- errors from the API ------------------------------------------------
  'error.unexpected': 'Something went wrong. Try again.',
  'error.authentication_required': 'You are signed out. Log in and try again.',
  'error.not_found': 'That is not there any more.',
  'error.invalid_input': 'That does not look right — check the form and try again.',
  'error.client_update_required': 'This app is out of date. Reload the page to update it.',
  'error.username_taken': 'That username is taken.',
  'error.invalid_credentials': 'Wrong username or password.',
  'error.wrong_password': 'Wrong password.',
  'error.no_such_account': 'No account with that name.',
  'error.policy_changed': 'The privacy policy changed while you were reading it. Reload and read it again.',
  'error.not_a_member': 'You are not in that group.',
  'error.last_admin': 'A group needs at least one admin.',
  'error.use_leave_to_remove_yourself': 'Use “leave” to remove yourself.',
  'error.no_pending_request': 'That request is no longer waiting.',
  'error.no_wraps_for_members': 'Nobody could be given access — try again.',
  'error.invite_invalid': 'This invite link is not valid any more.',
  'error.invite_spent': 'This invite link has already been used.',
  'error.join_declined': 'Your request to join was declined.',
  'error.attachment_missing': 'That receipt has not finished uploading.',
} satisfies Record<string, Message>;
