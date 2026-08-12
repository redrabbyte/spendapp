import { isApiErrorCode, isSplitErrorCode, type ApiErrorCode } from '@spendapp/shared';
import { activeLanguage, translate, type MessageKey, type TranslateOptions, type Translator } from './index';

/**
 * Turning a wire code into something worth reading.
 *
 * This lives at the API boundary rather than in every component: an error
 * message is copy, and the twenty places that render one should not each have
 * to know that. `api.ts` throws an `ApiError` whose message is already a
 * sentence in the reader's language, so every existing render site keeps
 * working untouched.
 *
 * An unrecognised code — an old app against a newer server — becomes a generic
 * sentence rather than the raw slug, which would be worse than useless in the
 * middle of a German interface.
 */
const KEYS: Record<ApiErrorCode, MessageKey> = {
  authentication_required: 'error.authentication_required',
  not_found: 'error.not_found',
  invalid_input: 'error.invalid_input',
  client_update_required: 'error.client_update_required',
  username_taken: 'error.username_taken',
  invalid_username: 'error.invalid_username',
  invalid_credentials: 'error.invalid_credentials',
  too_many_attempts: 'error.too_many_attempts',
  wrong_password: 'error.wrong_password',
  no_such_account: 'error.no_such_account',
  policy_changed: 'error.policy_changed',
  not_a_member: 'error.not_a_member',
  last_admin: 'error.last_admin',
  use_leave_to_remove_yourself: 'error.use_leave_to_remove_yourself',
  no_pending_request: 'error.no_pending_request',
  name_not_taken_over: 'error.name_not_taken_over',
  already_you: 'error.already_you',
  not_claimable: 'error.not_claimable',
  already_claimed: 'error.already_claimed',
  still_in_group: 'error.still_in_group',
  not_a_placeholder: 'error.not_a_placeholder',
  no_wraps_for_members: 'error.no_wraps_for_members',
  no_entries_in_group: 'error.no_entries_in_group',
  invite_invalid: 'error.invite_invalid',
  invite_spent: 'error.invite_spent',
  join_declined: 'error.join_declined',
  attachment_missing: 'error.attachment_missing',
  // Nothing a user did, and nothing they can act on: a stale tab, a bad
  // upload, a browser that changed its mind about a push subscription.
  internal_error: 'error.unexpected',
  csrf_header_missing: 'error.unexpected',
  identity_key_immutable: 'error.unexpected',
  attachment_too_short: 'error.unexpected',
  body_required: 'error.unexpected',
  invalid_subscription: 'error.unexpected',
};

/** The sentence to show for whatever the API said went wrong. */
export function messageForApiError(code: string): string {
  const key = isApiErrorCode(code) ? KEYS[code] : 'error.unexpected';
  return translate(activeLanguage(), key);
}

/**
 * An error this app raised itself, carrying the message key rather than the
 * message. Thrown from modules with no access to a hook — the crypto layer,
 * the sync engine, form validation — and rendered by the twenty components
 * that already print `err.message`.
 *
 * The sentence is built at construction, in the language selected then. An
 * error is transient and is read immediately, so that is the right moment;
 * anything stored and read later keeps a code instead (see SplitError).
 */
export class AppError extends Error {
  constructor(
    public readonly key: MessageKey,
    public readonly values: TranslateOptions = {},
  ) {
    super(translate(activeLanguage(), key, values));
    this.name = 'AppError';
  }
}

/** The stored reason a split was rejected, turned into a sentence on render. */
export function describeSplitError(t: Translator, reason: string): string {
  return isSplitErrorCode(reason) ? t(`split.${reason}`) : reason;
}
