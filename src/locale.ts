export type Locale = 'en' | 'ja';

const STORAGE_KEY = 'poietra-locale';
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

export function getLocale(): Locale {
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
  return resolveLocale({
    query: typeof location === 'undefined' ? null : new URL(location.href).searchParams.get('lang'),
    stored,
    languages: typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language],
  });
}

/** A language preference belongs to this browser, never to the shared project. */
export function setLocale(locale: Locale) {
  try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* The URL still preserves the explicit choice. */ }
  const url = new URL(location.href);
  url.searchParams.set('lang', locale);
  history.replaceState(history.state, '', url);
}

export const pageCopy = {
  en: {
    description: 'Create motion together with friends and AI. Animate shapes, equations, and media in your browser. Join through a shared link, with no login required.',
    loadError: 'Could not open this page',
    retryHint: 'Check your connection and try again.',
    retry: 'Reload',
    projectError: 'Could not open the project. Check your connection and try again.',
  },
  ja: {
    description: '友人と、AIと。図形・数式・素材に動きをつけて、ブラウザで一緒に動画をつくる。共有リンクからログインなしで参加できます。',
    loadError: 'ページを読み込めませんでした',
    retryHint: '接続を確認して、もう一度お試しください。',
    retry: '再読み込み',
    projectError: 'プロジェクトを開けませんでした。通信を確認して、もう一度お試しください。',
  },
} satisfies Record<Locale, Record<'description' | 'loadError' | 'retryHint' | 'retry' | 'projectError', string>>;

export function applyPageLanguage(locale: Locale) {
  document.documentElement.lang = locale;
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]']) {
    document.querySelector(selector)?.setAttribute('content', pageCopy[locale].description);
  }
}
