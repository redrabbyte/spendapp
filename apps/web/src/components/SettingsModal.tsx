import { useState } from 'react';
import { COMMON_CURRENCIES } from '@spendapp/shared';
import { LANGUAGES, type Language } from '../i18n';
import { useT } from '../i18n/useT';
import { timezoneList, useSettings, type Theme } from '../settings';
import { DeleteAccount, DownloadMyData } from './AccountData';
import { ChangePassword } from './ChangePassword';
import { EditAccount } from './EditAccount';
import { PushToggle } from './PushToggle';

const THEMES: Theme[] = ['system', 'light', 'dark'];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, update } = useSettings();
  const t = useT();
  const [tzFilter, setTzFilter] = useState('');
  const zones = timezoneList();
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const row = 'flex flex-col gap-1';
  const label = 'text-sm font-medium text-slate-500 dark:text-slate-400';
  const input =
    'rounded border border-slate-300 dark:border-slate-600 dark:bg-slate-800 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800';
  const chip = (on: boolean) =>
    `rounded px-3 py-1 text-sm ${
      on ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div
        className="mt-10 flex w-full max-w-sm flex-col gap-4 rounded-lg bg-white p-5 shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('settings.title')}</h2>
          <button
            onClick={onClose}
            aria-label={t('settings.close')}
            className="text-slate-400 hover:text-slate-600 dark:text-slate-300 dark:hover:text-slate-200"
          >
            ✕
          </button>
        </div>

        <div className={row}>
          <span className={label}>{t('settings.language')}</span>
          <div className="flex gap-1">
            {(Object.keys(LANGUAGES) as Language[]).map((code) => (
              <button
                key={code}
                onClick={() => update({ language: code })}
                className={chip(settings.language === code)}
              >
                {LANGUAGES[code]}
              </button>
            ))}
          </div>
        </div>

        <div className={row}>
          <span className={label}>{t('settings.appearance')}</span>
          <div className="flex gap-1">
            {THEMES.map((key) => (
              <button key={key} onClick={() => update({ theme: key })} className={chip(settings.theme === key)}>
                {t(`settings.theme.${key}`)}
              </button>
            ))}
          </div>
        </div>

        <div className={row}>
          <span className={label}>{t('settings.currency')}</span>
          <select
            className={input}
            value={settings.defaultCurrency}
            onChange={(e) => update({ defaultCurrency: e.target.value })}
          >
            {COMMON_CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <span className="text-xs text-slate-400">{t('settings.currency.hint')}</span>
        </div>

        <div className={row}>
          <span className={label}>{t('settings.timezone')}</span>
          <div className="flex gap-1">
            <button
              onClick={() => update({ displayTz: 'device' })}
              className={chip(settings.displayTz === 'device')}
            >
              {t('settings.timezone.device', { zone: deviceZone })}
            </button>
            <button
              onClick={() => update({ displayTz: settings.displayTz === 'device' ? deviceZone : settings.displayTz })}
              className={chip(settings.displayTz !== 'device')}
            >
              {t('settings.timezone.choose')}
            </button>
          </div>
          {settings.displayTz !== 'device' && (
            <>
              <input
                className={input}
                placeholder={t('settings.timezone.filter')}
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
          <span className="text-xs text-slate-400">{t('settings.timezone.hint')}</span>
        </div>

        <div className={row}>
          <span className={label}>{t('settings.notifications')}</span>
          <PushToggle />
        </div>

        <div className={row}>
          <EditAccount />
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
