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

  // accounts
  'username_taken',
  'invalid_credentials',
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
