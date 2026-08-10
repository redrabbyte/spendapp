import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { detectLanguage, isLanguage, type Language } from './i18n';

export type Theme = 'system' | 'light' | 'dark';
/** 'device' = the browser's local zone; otherwise an IANA name like 'Europe/Berlin'. */
export type DisplayTz = 'device' | string;

export interface Settings {
  theme: Theme;
  defaultCurrency: string;
  displayTz: DisplayTz;
  language: Language;
}

const DEFAULTS: Omit<Settings, 'language'> = { theme: 'system', defaultCurrency: 'EUR', displayTz: 'device' };
const KEY = 'settings';

function read(): Settings {
  // The browser's preference is the default, but only until someone chooses:
  // a stored language always wins, so travelling with a phone set to another
  // locale does not silently change the app.
  const fallback: Settings = { ...DEFAULTS, language: detectLanguage() };
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return {
      ...fallback,
      ...stored,
      language: isLanguage(stored.language) ? stored.language : fallback.language,
    };
  } catch {
    return fallback;
  }
}

interface Ctx {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}
const SettingsContext = createContext<Ctx | null>(null);

function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(read);

  // Screen readers announce in the wrong accent without this, and it is what
  // hyphenation and quotation marks key off.
  useEffect(() => {
    document.documentElement.lang = settings.language;
  }, [settings.language]);

  useEffect(() => {
    applyTheme(settings.theme);
    if (settings.theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [settings.theme]);

  const value = useMemo<Ctx>(
    () => ({
      settings,
      update: (patch) =>
        setSettings((prev) => {
          const next = { ...prev, ...patch };
          localStorage.setItem(KEY, JSON.stringify(next));
          return next;
        }),
    }),
    [settings],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Ctx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings outside SettingsProvider');
  return ctx;
}

/** IANA timezones for the picker (falls back to a small list on old engines). */
export function timezoneList(): string[] {
  const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (sv) {
    try {
      return sv('timeZone');
    } catch {
      /* fall through */
    }
  }
  return ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];
}

/**
 * Format a stored expense datetime for display in the chosen zone.
 *
 * `locale` is passed rather than left to the browser: the app's language is a
 * setting, and a German UI printing "Aug 10, 2026" because the phone is set to
 * English is the kind of half-translation that reads worse than no translation.
 */
export function formatExpenseDate(iso: string, displayTz: DisplayTz, locale?: string): string {
  if (iso.length <= 10) return new Date(`${iso}T00:00`).toLocaleDateString(locale); // legacy date-only
  const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  if (displayTz !== 'device') opts.timeZone = displayTz;
  return new Date(iso).toLocaleString(locale, opts);
}
