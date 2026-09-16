import { resolveLocale, type Locale } from './locale';

export interface PublicPagePlan {
  kind: 'home' | 'editor';
  locale: Locale;
  assetPath: string;
  contentType: string;
  headers: Record<string, string>;
}

function weightedValues(header: string | null): Array<{ value: string; quality: number }> {
  return (header ?? '').split(',').map(part => {
    const [value, ...parameters] = part.trim().split(';');
    const qualityParameter = parameters.map(parameter => parameter.trim()).find(parameter => /^q\s*=/i.test(parameter));
    const rawQuality = qualityParameter?.slice(qualityParameter.indexOf('=') + 1).trim();
    const quality = rawQuality === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(rawQuality) ? Number(rawQuality) : 0;
    return { value: value.toLowerCase(), quality };
  }).filter(entry => entry.value);
}

/** Markdown is opt-in. An explicit exclusion beats a less-specific wildcard. */
export function prefersMarkdown(accept: string | null): boolean {
  const values = weightedValues(accept);
  const markdown = values.find(entry => entry.value === 'text/markdown')?.quality ?? 0;
  const html = ['text/html', 'text/*', '*/*'].map(value => values.find(entry => entry.value === value)?.quality).find(quality => quality !== undefined) ?? 0;
  return markdown > 0 && markdown >= html;
}

/** Public entry routes only: assets, API endpoints and unknown paths pass through. */
export function publicPagePlan(url: URL, headers: Headers): PublicPagePlan | null {
  if (!['/', '/index.html', '/ja', '/ja/', '/ja/index.html', '/studio', '/studio/', '/studio/index.html'].includes(url.pathname)) return null;
  const editor = url.pathname.startsWith('/studio') || ['room', 'projects', 'auth_error'].some(key => url.searchParams.has(key));
  if (editor) return {
    kind: 'editor', locale: 'ja', assetPath: '/studio/index.html', contentType: 'text/html; charset=utf-8',
    headers: { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store' },
  };
  const languages = weightedValues(headers.get('Accept-Language')).filter(entry => entry.quality > 0).sort((a, b) => b.quality - a.quality).map(entry => entry.value);
  const query = url.searchParams.get('lang');
  const locale = resolveLocale({ query: query === 'en' || query === 'ja' ? query : url.pathname.startsWith('/ja') ? 'ja' : null, languages });
  const markdown = prefersMarkdown(headers.get('Accept'));
  return {
    kind: 'home', locale,
    assetPath: `${locale === 'ja' ? '/ja' : ''}/index.${markdown ? 'md' : 'html'}`,
    contentType: `${markdown ? 'text/markdown' : 'text/html'}; charset=utf-8`,
    headers: { 'Content-Language': locale, Vary: 'Accept, Accept-Language', 'Cache-Control': 'public, max-age=0, must-revalidate' },
  };
}

/** Keep the browser's room/query URL while fetching the generated static page. */
export async function fetchPublicPage(request: Request, fetchAsset: (request: Request) => Promise<Response>): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url), plan = publicPagePlan(url, request.headers);
  if (!plan) return null;
  const target = new URL(plan.assetPath, url);
  // Directory URLs are canonical for Static Assets' default HTML handling. Fetch
  // the binding directly, so /?room=... never redirects to /studio/ or loses IDs.
  if (target.pathname.endsWith('/index.html')) target.pathname = target.pathname.slice(0, -'index.html'.length);
  const response = await fetchAsset(new Request(target, { method: request.method, headers: request.headers, redirect: 'manual' }));
  const responseHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(plan.headers)) {
    if (key === 'Vary' && responseHeaders.has(key)) {
      responseHeaders.set(key, [...new Set([...responseHeaders.get(key)!.split(',').map(entry => entry.trim()), ...value.split(', ')])].join(', '));
    } else responseHeaders.set(key, value);
  }
  if (response.ok || response.status === 304) responseHeaders.set('Content-Type', plan.contentType);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
}
