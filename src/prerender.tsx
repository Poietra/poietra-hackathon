import { renderToString } from 'react-dom/server';
import { homeTree } from './home';
import { pageCopy, type Locale } from './locale';
import { LANDING_COPY } from './ui/landing-copy';

export function renderHome(locale: Locale) {
  return { html: renderToString(homeTree(locale)), description: pageCopy[locale].description };
}

/** The machine-readable introduction shares its factual copy with the visible page. */
export function renderMarkdown(locale: Locale) {
  const c = LANDING_COPY[locale];
  return [
    '# Poietra — Motion, together.',
    pageCopy[locale].description,
    c.introduction,
    `## ${c.detailTitle.join(' ')}`, c.detailDescription,
    `## ${c.sharingTitle}`, c.sharingDescription,
    `## ${c.aiTitle}`, `${c.aiBeforeMention}@codex${c.aiAfterMention}`,
    `## ${c.mediaTitle}`, c.mediaDescription,
    '## Links',
    '- [Open the studio](https://poietra.com/studio)\n- [English homepage](https://poietra.com/?lang=en)\n- [日本語](https://poietra.com/ja/)\n- [Source code](https://github.com/Poietra/poietra-hackathon)',
  ].join('\n\n') + '\n';
}
