import { useState } from 'react';
import { useT } from '../i18n/useT';

/**
 * Small "cloud-off" marker for an expense with unsynced local changes. Hover
 * (desktop) or tap (mobile) reveals the explanation. Rendered inside a link,
 * so it swallows the click rather than navigating.
 */
export function SyncPendingBadge({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const message = useT()('sync.pending');
  return (
    <span className={`relative inline-flex ${className ?? ''}`}>
      <span
        role="button"
        tabIndex={0}
        aria-label={message}
        title={message}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setOpen((o) => !o);
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="inline-flex cursor-help text-amber-500"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m2 2 20 20" />
          <path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193" />
          <path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07" />
        </svg>
      </span>
      {open && (
        <span className="absolute left-1/2 top-full z-20 mt-1 w-52 -translate-x-1/2 rounded bg-slate-800 px-2 py-1 text-xs font-normal text-white shadow-lg">
          {message}
        </span>
      )}
    </span>
  );
}
