import { describe, expect, it } from 'vitest';
import { applyTexCompletion, matchTexCompletions, TEX_COMPLETIONS, texCompletionContext } from '../src/ui/tex-completions';

describe('TeX completion context', () => {
  it('finds the command being typed before the caret', () => {
    expect(texCompletionContext('y = \\fr', 7)).toEqual({ start: 4, query: 'fr' });
    expect(texCompletionContext('\\alpha + \\be', 12)).toEqual({ start: 9, query: 'be' });
    expect(texCompletionContext('\\', 1)).toEqual({ start: 0, query: '' });
    expect(texCompletionContext('\\frac{}{}', 3)).toEqual({ start: 0, query: 'fr' });
  });
  it('ignores plain text, completed arguments and escaped line breaks', () => {
    expect(texCompletionContext('x + y', 5)).toBeNull();
    expect(texCompletionContext('\\frac{a', 7)).toBeNull();
    expect(texCompletionContext('a \\\\', 4)).toBeNull();
    expect(texCompletionContext('\\\\\\al', 5)).toEqual({ start: 2, query: 'al' });
  });
});

describe('TeX completion matching', () => {
  it('prefers short case-sensitive prefixes, then case-insensitive ones', () => {
    expect(matchTexCompletions('fr')[0].label).toBe('\\frac{}{}');
    expect(matchTexCompletions('Gam')[0].label).toBe('\\Gamma');
    expect(matchTexCompletions('gam').map(item => item.label)).toEqual(['\\gamma', '\\Gamma']);
    expect(matchTexCompletions('pm').map(item => item.label)).toEqual(['\\pm', '\\begin{pmatrix}']);
    expect(matchTexCompletions('s')[0].label).toBe('\\sum_{}^{}');
    expect(matchTexCompletions('zzz')).toEqual([]);
    expect(matchTexCompletions('')).toHaveLength(8);
    expect(matchTexCompletions('')[0].label).toBe('\\frac{}{}');
  });
  it('keeps every entry insertable', () => {
    expect(new Set(TEX_COMPLETIONS.map(item => item.label)).size).toBe(TEX_COMPLETIONS.length);
    for (const item of TEX_COMPLETIONS) {
      expect(item.insert.startsWith('\\')).toBe(true);
      expect(item.caret).toBeGreaterThan(0);
      expect(item.caret).toBeLessThanOrEqual(item.insert.length);
      expect(item.keys.every(key => /^[a-zA-Z]/.test(key))).toBe(true);
    }
  });
});

describe('applying a completion', () => {
  it('replaces the typed prefix and moves the caret into the first braces', () => {
    const frac = matchTexCompletions('frac')[0];
    expect(applyTexCompletion('x = \\fr + 1', 4, 7, frac)).toEqual({ text: 'x = \\frac{}{} + 1', caret: 10 });
    const alpha = matchTexCompletions('alpha')[0];
    expect(applyTexCompletion('\\alp', 0, 4, alpha)).toEqual({ text: '\\alpha', caret: 6 });
    const parentheses = matchTexCompletions('left')[0];
    expect(applyTexCompletion('\\le', 0, 3, parentheses)).toEqual({ text: '\\left( \\right)', caret: 7 });
    const matrix = matchTexCompletions('pmatrix')[0];
    const applied = applyTexCompletion('\\pmat', 0, 5, matrix);
    expect(applied.text).toBe('\\begin{pmatrix}  \\end{pmatrix}');
    expect(applied.text.slice(applied.caret - 1, applied.caret + 1)).toBe('  ');
  });
});
