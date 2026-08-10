import { isApiErrorCode, type ApiErrorCode } from '@spendapp/shared';
import { activeLanguage, translate, type MessageKey } from './index';

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
  invalid_credentials: 'error.invalid_credentials',
  wrong_password: 'error.wrong_password',
  no_such_account: 'error.no_such_account',
  policy_changed: 'error.policy_changed',
  not_a_member: 'error.not_a_member',
  last_admin: 'error.last_admin',
  use_leave_to_remove_yourself: 'error.use_leave_to_remove_yourself',
  no_pending_request: 'error.no_pending_request',
  no_wraps_for_members: 'error.no_wraps_for_members',
  invite_invalid: 'error.invite_invalid',
  invite_spent: 'error.invite_spent',
  join_declined: 'error.join_declined',
  attachment_missing: 'error.attachment_missing',
  // Nothing a user did, and nothing they can act on: a stale tab, a bad
  // upload, a browser that changed its mind about a push subscription.
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
