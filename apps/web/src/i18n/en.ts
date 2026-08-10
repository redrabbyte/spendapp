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
