import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n/useT';
import { Markdown } from './Markdown';

export interface Policy {
  version: string;
  text: string;
  /** False when the server is serving the committed placeholder. */
  installed: boolean;
}

/** Fetch once per page: it is the same answer for everyone and rarely changes. */
let cached: Promise<Policy> | null = null;
export const fetchPolicy = (): Promise<Policy> => (cached ??= api<Policy>('/api/privacy'));

/**
 * The policy text, in a box you can actually scroll. Deliberately shown rather
 * than linked at the point of consent: a checkbox next to a link records that
 * somebody clicked a checkbox.
 *
 * This used to print the markdown raw, on the reasoning that a renderer would
 * be both a dependency and an injection surface for a file edited outside
 * review. The first half stands and is answered by writing the sixty lines
 * (`Markdown.tsx`); the second was only ever true of `dangerouslySetInnerHTML`.
 * Rendering to React elements escapes every text node, so the file cannot
 * inject anything — and a policy whose headings and emphasis survive is one
 * more person will actually read before agreeing to it.
 */
export function PrivacyNotice({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div
      className={`max-h-56 overflow-y-auto rounded border border-slate-300 bg-slate-50 p-3 text-left text-xs leading-relaxed text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 ${className}`}
    >
      <Markdown text={text} />
    </div>
  );
}

/**
 * Loads the policy and reports whether it is worth trusting. `null` while
 * loading; the caller must not let anyone accept before it arrives.
 */
export function usePolicy(): { policy: Policy | null; error: string | null } {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetchPolicy()
      .then((p) => live && setPolicy(p))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, []);
  return { policy, error };
}

/** Shown when the placeholder is being served — a deployment mistake, not a policy. */
export function PlaceholderWarning() {
  const t = useT();
  return (
    <p className="rounded bg-amber-50 p-2 text-left text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
      {t('login.policy.placeholder')}
    </p>
  );
}
