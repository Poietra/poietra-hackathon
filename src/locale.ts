import { resolveLocale, type Locale } from '../shared/locale';
export { resolveLocale, type Locale } from '../shared/locale';

const STORAGE_KEY = 'poietra-locale';

export function getLocale(): Locale {
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
  const url = typeof location === 'undefined' ? null : new URL(location.href);
  const query = url?.searchParams.get('lang');
  return resolveLocale({
    query: query === 'en' || query === 'ja' ? query : url && /^\/ja(?:\/|\/index\.html)?$/.test(url.pathname) ? 'ja' : null,
    stored,
    languages: typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language],
  });
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
