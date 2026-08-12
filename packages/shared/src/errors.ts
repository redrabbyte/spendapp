/**
 * The codes an API error can carry.
 *
 * The server used to send English prose in `error`, and the client rendered it
 * verbatim — which made every handler a place where user-facing copy lived,
 * and made translating the app impossible without translating the backend too.
 * It sends a code now, and the client owns every word the user reads.
 *
 * Shared so the two cannot drift: a code the client has no message for is a
 * compile error on its side, not a blank box in front of somebody.
 */
export const API_ERRORS = [
  'authentication_required',
  'not_found',
  'invalid_input',
  'csrf_header_missing',
  'client_update_required',
  // Something went wrong that the caller cannot act on; the detail is in the log.
  'internal_error',

  // accounts
  'username_taken',
  // Distinct from `invalid_input` on purpose: it is the one validation failure
  // a person can actually act on, and "check the form" does not tell them
  // which of three fields to look at (see `usernameSchema`).
  'invalid_username',
  'invalid_credentials',
  // Too many failed logins for this account, whatever address they came from.
  'too_many_attempts',
  'wrong_password',
  'no_such_account',
  'identity_key_immutable',

  // policy
  'policy_changed',

  // groups and membership
  'not_a_member',
  'last_admin',
  'use_leave_to_remove_yourself',
  'no_pending_request',
  // Taking over a placeholder or a departed member's name.
  'name_not_taken_over',
  'already_you',
  'not_claimable',
  'already_claimed',
  'still_in_group',
  'no_wraps_for_members',

  // invites
  'invite_invalid',
  'invite_spent',
  'join_declined',

  // attachments
  'attachment_missing',
  'attachment_too_short',
  'body_required',

  // push
  'invalid_subscription',
] as const;

export type ApiErrorCode = (typeof API_ERRORS)[number];

export const isApiErrorCode = (v: unknown): v is ApiErrorCode =>
  typeof v === 'string' && (API_ERRORS as readonly string[]).includes(v);

/**
 * Why a split or an amount was refused.
 *
 * Codes rather than sentences for the same reason the API sends codes, and one
 * more: a failing entry's reason is *stored* in the local mirror and rendered
 * later, so a sentence written at validation time would be frozen in whatever
 * language was selected the moment it was checked.
 */
export const SPLIT_ERRORS = [
  'no_participants',
  'invalid_weight',
  'invalid_total',
  'weights_sum_zero',
  'duplicate_participant',
  'exact_sum_mismatch',
  'percent_sum_mismatch',
  'invalid_shares',
  'no_splits',
  'invalid_amount',
  'invalid_paid',
  'invalid_owed',
  'paid_sum_mismatch',
  'owed_sum_mismatch',
] as const;

export type SplitErrorCode = (typeof SPLIT_ERRORS)[number];

export const isSplitErrorCode = (v: unknown): v is SplitErrorCode =>
  typeof v === 'string' && (SPLIT_ERRORS as readonly string[]).includes(v);

/**
 * Carries the code as its message, so anything that only knows how to print an
 * Error still shows something stable and greppable rather than "[object
 * Object]" — and anything that knows better can translate it.
 */
export class SplitError extends Error {
  constructor(public readonly code: SplitErrorCode) {
    super(code);
    this.name = 'SplitError';
  }
}

/**
 * What was wrong with a row of an imported CSV.
 *
 * Codes again, and for a plain reason: the parser is shared, runs before
 * anything knows who is reading, and its findings are shown in a list next to
 * the row they are about. A sentence built here would be English in a German
 * dialog.
 */
export const IMPORT_WARNINGS = [
  'unrecognised_currency',
  'amounts_do_not_cancel',
  'payment_too_many_people',
  'nobody_paid',
  'several_payers',
  'split_totals_mismatch',
] as const;

export type ImportWarningCode = (typeof IMPORT_WARNINGS)[number];

export const isImportWarningCode = (v: unknown): v is ImportWarningCode =>
  typeof v === 'string' && (IMPORT_WARNINGS as readonly string[]).includes(v);

/**
 * A file that is neither of the two formats. Its own class so the dialog can
 * tell "this is not a CSV we know" apart from "reading the file failed", which
 * are different things to say to somebody.
 */
export class ImportFormatError extends Error {
  constructor() {
    super('unrecognised_csv');
    this.name = 'ImportFormatError';
  }
}

/** The row it is about — its description, or its date when it has no name. */
export interface ImportWarning {
  row: string;
  code: ImportWarningCode;
  /** Only for `unrecognised_currency`: what the file actually said. */
  currency?: string;
}
