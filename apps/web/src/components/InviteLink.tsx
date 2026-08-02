import { useEffect, useState } from 'react';

/**
 * navigator.clipboard needs a secure context, and this app is often reached
 * over plain http on a LAN — so fall back to the legacy selection trick
 * rather than leaving the button dead.
 */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* insecure context or denied — try the fallback below */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length); // iOS ignores select() on its own
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('copy rejected');
}

const icon = 'h-4 w-4';
const iconProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: icon,
  'aria-hidden': true,
} as const;

function CopyIcon() {
  return (
    <svg {...iconProps}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg {...iconProps}>
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

export function InviteLink({ url }: { url: string }) {
  const [note, setNote] = useState<string | null>(null);
  // Only mobile browsers implement the share sheet; elsewhere copy is all there is.
  const canShare = typeof navigator.share === 'function';

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 2500);
    return () => clearTimeout(t);
  }, [note]);

  async function copy() {
    try {
      await copyText(url);
      setNote('Copied');
    } catch {
      setNote('Could not copy — select the link and copy it by hand');
    }
  }

  async function share() {
    try {
      await navigator.share({ title: 'SpendApp', text: 'Join my group on SpendApp', url });
    } catch (err) {
      // Dismissing the sheet rejects with AbortError; that is not a failure.
      if ((err as Error).name !== 'AbortError') setNote('Sharing failed');
    }
  }

  const button =
    'shrink-0 rounded p-1.5 text-teal-800 hover:bg-teal-100 dark:text-teal-200 dark:hover:bg-teal-900';

  return (
    <div className="rounded bg-teal-50 p-2 text-sm text-teal-900 dark:bg-teal-950 dark:text-teal-100">
      <div className="flex items-start gap-1">
        <span className="grow break-all">
          Share this link (valid 14 days): {url}
        </span>
        <button onClick={() => void copy()} className={button} title="Copy link" aria-label="Copy link">
          <CopyIcon />
        </button>
        {canShare && (
          <button onClick={() => void share()} className={button} title="Share link" aria-label="Share link">
            <ShareIcon />
          </button>
        )}
      </div>
      {note && (
        <p role="status" className="mt-1 text-xs text-teal-700 dark:text-teal-300">
          {note}
        </p>
      )}
    </div>
  );
}
