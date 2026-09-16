export type Locale = 'en' | 'ja';

const explicitLocale = (value: string | null | undefined): Locale | null => value === 'en' || value === 'ja' ? value : null;

/** Explicit choices win; otherwise use the first supported browser language, then English. */
export function resolveLocale({ query, stored, languages = [] }: {
  query?: string | null;
  stored?: string | null;
  languages?: readonly string[];
} = {}): Locale {
  const selected = explicitLocale(query) ?? explicitLocale(stored);
  if (selected) return selected;
  for (const tag of languages) {
    try {
      const supported = explicitLocale(new Intl.Locale(tag).language);
      if (supported) return supported;
    } catch { /* Ignore malformed language tags and continue through the preference list. */ }
  }
  return 'en';
}

