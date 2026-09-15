import interUrl from '@fontsource/inter/files/inter-latin-400-normal.woff2?url';
import japaneseCss from '@fontsource/noto-sans-jp/400.css?raw';

// Unicode ranges select only the locally bundled subsets a scene actually uses.
const japaneseAssets = import.meta.glob<string>('../../../node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-{[0-9]*,latin,latin-ext,cyrillic,vietnamese}-400-normal.woff2', { eager: true, query: '?url', import: 'default' });
const urlsByName = new Map(Object.entries(japaneseAssets).map(([path, url]) => [path.split('/').at(-1)!, url]));

export interface FontAsset { family: string; url: string; unicodeRange?: string; ranges?: [number, number][] }
export const fontAssets: FontAsset[] = [
  { family: 'Poietra Inter', url: interUrl },
  ...[...japaneseCss.matchAll(/@font-face\s*\{([^}]+)\}/g)].flatMap(([, declaration]): FontAsset[] => {
    const name = /url\(\.\/files\/([^)]*\.woff2)\)/.exec(declaration)?.[1];
    const unicodeRange = /unicode-range:\s*([^;]+);/.exec(declaration)?.[1];
    const url = name && urlsByName.get(name);
    if (!url || !unicodeRange) return [];
    const ranges = unicodeRange.split(',').map(range => {
      const [start, end = start] = range.trim().slice(2).split('-');
      return [parseInt(start, 16), parseInt(end, 16)] as [number, number];
    });
    return [{ family: 'Poietra Noto Sans JP', url, unicodeRange, ranges }];
  }),
];
