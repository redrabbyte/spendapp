import type { ApiErrorCode } from '@spendapp/shared';

/**
 * An error that already knows what the client should be told.
 *
 * The lib modules used to throw `new Error('that is already you')` and the
 * routes sent the message straight back in `error` — a field the client is
 * typed to treat as a code, so the prose arrived where a translation key was
 * expected. It also put whatever an unexpected exception said in front of the
 * caller, constraint names and driver text included, and it slipped past
 * errors.test.ts, which scans the source for literal codes and cannot see a
 * value assembled at runtime.
 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly statusCode = 400,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export const isApiError = (err: unknown): err is ApiError => err instanceof ApiError;
