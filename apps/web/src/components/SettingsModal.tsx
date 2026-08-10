import { useState } from 'react';
import { COMMON_CURRENCIES } from '@spendapp/shared';
import { timezoneList, useSettings, type Theme } from '../settings';
import { DeleteAccount, DownloadMyData } from './AccountData';
import { ChangePassword } from './ChangePassword';
import { PushToggle } from './PushToggle';

const THEMES: { key: Theme; label: string }[] = [
  { key: 'system', label: 'system' },
  { key: 'light', label: 'light' },
  { key: 'dark', label: 'dark' },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, update } = useSettings();
  const [tzFilter, setTzFilter] = useState('');
  const zones = timezoneList();
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const row = 'flex flex-col gap-1';
  const label = 'text-sm font-medium text-slate-500 dark:text-slate-400';
  const input =
    'rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div
        className="mt-10 flex w-full max-w-sm flex-col gap-4 rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:text-slate-300 dark:hover:text-slate-200">
            ✕
          </button>
        </div>

        <div className={row}>
          <span className={label}>Appearance</span>
          <div className="flex gap-1">
            {THEMES.map(({ key, label: l }) => (
              <button
                key={key}
                onClick={() => update({ theme: key })}
                className={`rounded px-3 py-1 text-sm capitalize ${
                  settings.theme === key
                    ? 'bg-teal-700 text-white'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 dark:bg-slate-800 dark:text-slate-300'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className={row}>
          <span className={label}>My default currency</span>
          <select
            className={input}
            value={settings.defaultCurrency}
            onChange={(e) => update({ defaultCurrency: e.target.value })}
          >
            {COMMON_CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <span className="text-xs text-slate-400">Pre-selected when you create a new group.</span>
        </div>

        <div className={row}>
          <span className={label}>Display timezone</span>
          <div className="flex gap-1">
            <button
              onClick={() => update({ displayTz: 'device' })}
              className={`rounded px-3 py-1 text-sm ${
                settings.displayTz === 'device'
                  ? 'bg-teal-700 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 dark:bg-slate-800 dark:text-slate-300'
              }`}
            >
              device ({deviceZone})
            </button>
            <button
              onClick={() => update({ displayTz: settings.displayTz === 'device' ? deviceZone : settings.displayTz })}
              className={`rounded px-3 py-1 text-sm ${
                settings.displayTz !== 'device'
                  ? 'bg-teal-700 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 dark:bg-slate-800 dark:text-slate-300'
              }`}
            >
              choose…
            </button>
          </div>
          {settings.displayTz !== 'device' && (
            <>
              <input
                className={input}
                placeholder="filter zones…"
                value={tzFilter}
                onChange={(e) => setTzFilter(e.target.value)}
              />
              <select
                className={input}
                size={6}
                value={settings.displayTz}
                onChange={(e) => update({ displayTz: e.target.value })}
              >
                {zones
                  .filter((z) => z.toLowerCase().includes(tzFilter.toLowerCase()))
                  .map((z) => (
                    <option key={z}>{z}</option>
                  ))}
              </select>
            </>
          )}
          <span className="text-xs text-slate-400">Times are stored in UTC and shown in this zone.</span>
        </div>

        <div className={row}>
          <span className={label}>Notifications</span>
          <PushToggle />
        </div>

        <div className={row}>
          <ChangePassword />
        </div>

        <div className={row}>
          <DownloadMyData />
        </div>

        <div className={`${row} border-t border-slate-200 pt-4 dark:border-slate-700`}>
          <DeleteAccount />
        </div>
      </div>
    </div>
  );
}
