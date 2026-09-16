import { describe, expect, test } from 'vitest';
import { resolveLocale } from '../src/locale';

type Preference = Parameters<typeof resolveLocale>[0];
const cases: Array<[string, Preference, 'en' | 'ja']> = [
  ['an explicit Japanese link overrides saved English and an English browser', { query: 'ja', stored: 'en', languages: ['en-US'] }, 'ja'],
  ['an explicit English link overrides saved Japanese and a Japanese browser', { query: 'en', stored: 'ja', languages: ['ja-JP'] }, 'en'],
  ['an invalid regional URL selection leaves the saved preference in control', { query: 'ja-JP', stored: 'en', languages: ['ja-JP'] }, 'en'],
  ['a saved Japanese choice takes priority over the browser list', { query: null, stored: 'ja', languages: ['en-GB', 'ja-JP'] }, 'ja'],
  ['URL and saved choices require exact lowercase codes', { query: 'JA', stored: ' ja ', languages: ['en-US'] }, 'en'],
  ['the first supported browser preference wins after unsupported languages', { languages: ['fr-FR', 'ja-JP', 'en-US'] }, 'ja'],
  ['browser regional tags are case insensitive and preserve preference order', { languages: ['EN-gb', 'ja-JP'] }, 'en'],
  ['malformed browser values are skipped instead of matching a language prefix', { query: '', stored: '', languages: ['', 'jafoobar', 'en_US', 'ja-', '--ja', 'JA-jp'] }, 'ja'],
  ['unsupported or malformed preferences fall back to English', { query: 'fr', stored: 'ja-JP', languages: ['jafoobar', 'ja-', 'de-DE', 'ko-KR'] }, 'en'],
  ['a visitor without any supplied preferences receives English', {}, 'en'],
];

describe('homepage language preference precedence', () => {
  test.each(cases)('%s', (_description, preferences, expected) => {
    expect(resolveLocale(preferences)).toBe(expected);
  });
});
