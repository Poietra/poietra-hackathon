import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { renderHome, renderMarkdown } = await vite.ssrLoadModule('/src/prerender.tsx');
  const shell = await readFile('dist/index.html', 'utf8');
  const manifest = JSON.parse(await readFile('dist/.vite/manifest.json', 'utf8'));
  const home = manifest['src/home.tsx'];
  if (!home) throw new Error('Homepage entry is missing from the build manifest');
  const styles = new Set();
  const visit = entry => { for (const css of entry.css ?? []) styles.add(css); for (const key of entry.imports ?? []) visit(manifest[key]); };
  visit(home);
  const links = [...styles].map(css => `<link rel="stylesheet" crossorigin href="/${css}" />`).join('\n');
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  for (const locale of ['en', 'ja']) {
    const { html, description } = renderHome(locale);
    const canonical = `https://poietra.com/${locale === 'ja' ? 'ja/' : ''}`;
    const schema = {
      '@context': 'https://schema.org', '@type': 'WebApplication', name: 'Poietra',
      url: canonical, description, applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Web browser', inLanguage: locale,
      image: 'https://poietra.com/studio-preview.png',
      featureList: ['Real-time collaborative editing', 'Editable animation and Bézier paths', 'AI-assisted editing', 'Image, audio and video media', 'MP4 and WebM export'],
    };
    const head = `${links}
    <link rel="modulepreload" crossorigin href="/${home.file}" />
    <link rel="canonical" href="${canonical}" />
    <link rel="alternate" hreflang="en" href="https://poietra.com/" />
    <link rel="alternate" hreflang="ja" href="https://poietra.com/ja/" />
    <link rel="alternate" hreflang="x-default" href="https://poietra.com/" />
    <link rel="alternate" type="text/markdown" href="/${locale === 'ja' ? 'ja/' : ''}index.md" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:locale" content="${locale === 'ja' ? 'ja_JP' : 'en_US'}" />
    <script type="application/ld+json">${JSON.stringify(schema).replaceAll('<', '\\u003c')}</script>`;
    const page = shell.replace('<html lang="en">', `<html lang="${locale}">`)
      .replace(/(<meta (?:name="description"|property="og:description") content=")[^"]*"/g, `$1${escape(description)}"`)
      .replace('</head>', `${head}\n</head>`)
      .replace('<body>', '<body data-page="home">')
      .replace('<div id="root"></div>', `<div id="root" data-locale="${locale}">${html}</div>`);
    const directory = locale === 'ja' ? 'dist/ja' : 'dist';
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/index.html`, page);
    await writeFile(`${directory}/index.md`, renderMarkdown(locale));
  }
  await mkdir('dist/studio', { recursive: true });
  await writeFile('dist/studio/index.html', shell
    .replace('</head>', '<meta name="robots" content="noindex, nofollow" />\n</head>')
    .replace('<body>', '<body data-page="editor">'));
  // Unknown URLs must not become duplicate marketing pages through SPA fallback.
  await writeFile('dist/404.html', '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex"><title>Page not found — Poietra</title><h1>Page not found</h1><a href="/">Poietra home</a></html>');
  console.log('Prerendered English/Japanese homepages, Markdown, and editor shell.');
} finally { await vite.close(); }
