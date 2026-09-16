import { describe, expect, it } from 'vitest';
import { fetchPublicPage, prefersMarkdown, publicPagePlan } from '../shared/public-site';

const plan = (path = '/', headers: Record<string, string> = {}) => publicPagePlan(new URL(path, 'https://poietra.com'), new Headers(headers));

describe('public homepage routing', () => {
  it('chooses generated locale pages using explicit URL then weighted language preferences', () => {
    expect(plan()?.assetPath).toBe('/index.html');
    expect(plan('/', { 'Accept-Language': 'fr-FR,ja-JP;q=0.8,en-US;q=0.5' })?.assetPath).toBe('/ja/index.html');
    expect(plan('/', { 'Accept-Language': 'ja;q=0,en;q=0.8' })?.locale).toBe('en');
    expect(plan('/', { 'Accept-Language': 'ja;q=invalid,en;q=0.5' })?.locale).toBe('en');
    expect(plan('/?lang=en', { 'Accept-Language': 'ja' })?.locale).toBe('en');
    expect(plan('/?lang=invalid', { 'Accept-Language': 'ja' })?.locale).toBe('ja');
    expect(plan('/ja/', { 'Accept-Language': 'en' })?.locale).toBe('ja');
    expect(plan('/ja/?lang=en', { 'Accept-Language': 'ja' })?.locale).toBe('en');
  });

  it('keeps shared, legacy studio and OAuth callback entries out of public pages and Markdown', () => {
    for (const path of ['/?room=shared-room-123456', '/?room=', '/?projects=1', '/?auth_error=denied', '/studio', '/studio/', '/studio/index.html', '/ja/?room=shared-room-123456&lang=en']) {
      const result = plan(path, { Accept: 'text/markdown', 'Accept-Language': 'en' });
      expect(result).toMatchObject({ kind: 'editor', assetPath: '/studio/index.html', contentType: 'text/html; charset=utf-8' });
      expect(result?.headers['X-Robots-Tag']).toContain('noindex');
      expect(result?.headers['Cache-Control']).toContain('no-store');
    }
    for (const path of ['/api/auth/session', '/sync/a-room', '/assets/script.js', '/robots.txt', '/sitemap.xml', '/unknown']) expect(plan(path)).toBeNull();
  });

  it('requires an explicit acceptable Markdown preference and respects HTML quality and exclusions', () => {
    for (const accept of [null, '*/*', 'text/*', 'text/html', 'text/markdown;q=0', 'text/markdown;q=0.4,text/html;q=0.9', 'text/markdown;q=0.4,*/*;q=0.9', 'text/markdown;q=invalid', 'text/markdown;q=2']) expect(prefersMarkdown(accept)).toBe(false);
    for (const accept of ['text/markdown', 'text/markdown,text/html', 'text/markdown;q=0.8,text/html;q=0.4', 'text/markdown;q=0.8,text/html;q=0,*/*;q=1']) expect(prefersMarkdown(accept)).toBe(true);
    const markdown = plan('/?lang=ja', { Accept: 'text/markdown' });
    expect(markdown).toMatchObject({ assetPath: '/ja/index.md', contentType: 'text/markdown; charset=utf-8' });
    expect(markdown?.headers.Vary).toBe('Accept, Accept-Language');
  });

  it('rewrites only the binding request, preserves response body and status, and keeps conditional headers', async () => {
    const original = new Request('https://poietra.com/?room=private-room-123456&projects=1', { headers: { 'If-None-Match': 'etag' } });
    let assetRequest: Request | undefined;
    const result = await fetchPublicPage(original, async request => {
      assetRequest = request;
      return new Response('editor shell', { headers: { ETag: 'etag', 'Content-Type': 'text/html', 'X-Asset': 'preserved' } });
    });
    expect(assetRequest?.url).toBe('https://poietra.com/studio/');
    expect(assetRequest?.headers.get('If-None-Match')).toBe('etag');
    expect(original.url).toContain('?room=private-room-123456&projects=1');
    expect(result?.status).toBe(200);
    expect(result?.headers.get('Location')).toBeNull();
    expect(result?.headers.get('X-Asset')).toBe('preserved');
    expect(result?.headers.get('X-Robots-Tag')).toContain('noindex');
    expect(await result?.text()).toBe('editor shell');
  });

  it('preserves asset errors and HEAD/304 responses instead of reporting a successful page', async () => {
    const failed = await fetchPublicPage(new Request('https://poietra.com/'), async () => new Response('missing', { status: 404, headers: { 'Content-Type': 'text/plain' } }));
    expect(failed?.status).toBe(404);
    expect(failed?.headers.get('Content-Type')).toBe('text/plain');
    const cached = await fetchPublicPage(new Request('https://poietra.com/?lang=ja', { method: 'HEAD' }), async request => {
      expect(request.method).toBe('HEAD');
      return new Response(null, { status: 304, headers: { ETag: 'japanese', Vary: 'Origin' } });
    });
    expect(cached?.status).toBe(304);
    expect(cached?.body).toBeNull();
    expect(cached?.headers.get('Vary')).toBe('Origin, Accept, Accept-Language');
    expect(cached?.headers.get('Content-Language')).toBe('ja');
    expect(await fetchPublicPage(new Request('https://poietra.com/', { method: 'POST' }), async () => { throw new Error('Unexpected asset fetch'); })).toBeNull();
  });
});
