import { messageForApiError } from './i18n/errors';

export class ApiError extends Error {
  constructor(
    public status: number,
    /** Already translated — safe to render straight into the UI. */
    message: string,
    /** The untranslated wire code, for the rare caller that branches on it. */
    public code = '',
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: {
      'x-requested-with': 'spendapp', // CSRF check on the server
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    // The server sends a code, never prose — it has no idea what language the
    // reader chose. Translating here means the twenty places that render an
    // error do not each have to know that.
    let code = '';
    try {
      code = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* non-json error body */
    }
    throw new ApiError(res.status, messageForApiError(code), code);
  }
  return (await res.json()) as T;
}
