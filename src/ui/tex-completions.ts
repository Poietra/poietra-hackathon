export interface TexCompletion {
  /** Shown in the list, for example \frac{}{}. */
  label: string;
  insert: string;
  /** Caret offset inside insert after accepting. */
  caret: number;
  /** Command names matched against the letters typed after the backslash. */
  keys: string[];
  hint?: string;
}

const command = (name: string, hint?: string): TexCompletion => ({ label: `\\${name}`, insert: `\\${name}`, caret: name.length + 1, keys: [name], hint });
const snippet = (name: string, body: string, hint?: string): TexCompletion => {
  const insert = `\\${name}${body}`;
  return { label: insert, insert, caret: insert.indexOf('{}') + 1, keys: [name], hint };
};
const pair = (open: string, close: string, hint: string): TexCompletion => {
  const head = `\\left${open} `;
  return { label: `${head}\\right${close}`, insert: `${head}\\right${close}`, caret: head.length, keys: ['left'], hint };
};
const environment = (name: string, hint: string, columns = ''): TexCompletion => {
  const head = `\\begin{${name}}${columns} `;
  return { label: `\\begin{${name}}`, insert: `${head} \\end{${name}}`, caret: head.length, keys: [`begin{${name}}`, name], hint };
};
const symbols = (entries: readonly (readonly [string, string?])[]) => entries.map(([name, hint]) => command(name, hint));

/** MathJax base + ams commands the editor renders; ordered by how often motion-graphics math needs them. */
export const TEX_COMPLETIONS: TexCompletion[] = [
  snippet('frac', '{}{}', '分数'), snippet('sqrt', '{}', '平方根'), snippet('sum', '_{}^{}', '∑'), snippet('int', '_{}^{}', '∫'), snippet('prod', '_{}^{}', '∏'), snippet('lim', '_{}', '極限'),
  snippet('dfrac', '{}{}', '分数（大）'), snippet('binom', '{}{}', '二項係数'),
  snippet('mathbf', '{}', '太字'), snippet('mathrm', '{}', '立体'), snippet('mathbb', '{}', '黒板太字'), snippet('mathcal', '{}', 'カリグラフィ'), snippet('text', '{}', 'テキスト'), snippet('operatorname', '{}', '演算子名'), snippet('boxed', '{}', '枠'),
  snippet('hat', '{}', 'â'), snippet('bar', '{}', 'ā'), snippet('vec', '{}', 'ベクトル'), snippet('dot', '{}', 'ȧ'), snippet('tilde', '{}', 'ã'), snippet('overline', '{}', '上線'), snippet('underline', '{}', '下線'),
  snippet('overbrace', '{}', '上括弧'), snippet('underbrace', '{}', '下括弧'), snippet('overset', '{}{}', '上に重ねる'), snippet('underset', '{}{}', '下に重ねる'), snippet('xrightarrow', '{}', '文字付き矢印'),
  pair('(', ')', '括弧'), pair('[', ']', '角括弧'), pair('\\{', '\\}', '波括弧'), pair('|', '|', '絶対値'),
  environment('pmatrix', '( ) 行列'), environment('bmatrix', '[ ] 行列'), environment('vmatrix', '| | 行列'), environment('matrix', '行列'), environment('cases', '場合分け'), environment('aligned', '複数行の整列'), environment('array', '配列', '{cc}'),
  ...symbols([['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ϵ'], ['varepsilon', 'ε'], ['zeta', 'ζ'], ['eta', 'η'], ['theta', 'θ'], ['vartheta', 'ϑ'], ['iota', 'ι'], ['kappa', 'κ'], ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['pi', 'π'], ['rho', 'ρ'], ['sigma', 'σ'], ['tau', 'τ'], ['upsilon', 'υ'], ['phi', 'ϕ'], ['varphi', 'φ'], ['chi', 'χ'], ['psi', 'ψ'], ['omega', 'ω']]),
  ...symbols([['Gamma', 'Γ'], ['Delta', 'Δ'], ['Theta', 'Θ'], ['Lambda', 'Λ'], ['Xi', 'Ξ'], ['Pi', 'Π'], ['Sigma', 'Σ'], ['Upsilon', 'Υ'], ['Phi', 'Φ'], ['Psi', 'Ψ'], ['Omega', 'Ω']]),
  ...symbols([['partial', '∂'], ['nabla', '∇'], ['infty', '∞'], ['cdot', '·'], ['times', '×'], ['div', '÷'], ['pm', '±'], ['mp', '∓'], ['leq', '≤'], ['geq', '≥'], ['neq', '≠'], ['approx', '≈'], ['equiv', '≡'], ['sim', '∼'], ['simeq', '≃'], ['propto', '∝'], ['ll', '≪'], ['gg', '≫'], ['circ', '∘'], ['ast', '∗'], ['star', '⋆'], ['perp', '⊥'], ['parallel', '∥'], ['angle', '∠'], ['prime', '′'], ['hbar', 'ℏ'], ['ell', 'ℓ'], ['therefore', '∴'], ['because', '∵']]),
  ...symbols([['to', '→'], ['rightarrow', '→'], ['leftarrow', '←'], ['Rightarrow', '⇒'], ['Leftarrow', '⇐'], ['leftrightarrow', '↔'], ['Leftrightarrow', '⇔'], ['mapsto', '↦'], ['uparrow', '↑'], ['downarrow', '↓'], ['implies', '⟹'], ['iff', '⟺']]),
  ...symbols([['in', '∈'], ['notin', '∉'], ['subset', '⊂'], ['subseteq', '⊆'], ['supset', '⊃'], ['supseteq', '⊇'], ['cup', '∪'], ['cap', '∩'], ['setminus', '∖'], ['emptyset', '∅'], ['varnothing', '∅'], ['forall', '∀'], ['exists', '∃'], ['nexists', '∄'], ['neg', '¬'], ['land', '∧'], ['lor', '∨']]),
  ...symbols([['ldots', '…'], ['cdots', '⋯'], ['vdots', '⋮'], ['ddots', '⋱'], ['dots', '…'], ['quad', '空白'], ['qquad', '広い空白']]),
  ...symbols([['sin'], ['cos'], ['tan'], ['cot'], ['sec'], ['csc'], ['arcsin'], ['arccos'], ['arctan'], ['sinh'], ['cosh'], ['tanh'], ['log'], ['ln'], ['exp'], ['max'], ['min'], ['sup'], ['inf'], ['arg'], ['det'], ['gcd'], ['deg']]),
  ...symbols([['langle', '⟨'], ['rangle', '⟩'], ['lvert', '|'], ['rvert', '|'], ['lVert', '‖'], ['rVert', '‖'], ['lfloor', '⌊'], ['rfloor', '⌋'], ['lceil', '⌈'], ['rceil', '⌉']]),
];

/** The command being typed before the caret; an even run of backslashes is a TeX line break, not a command. */
export function texCompletionContext(text: string, caret: number): { start: number; query: string } | null {
  const match = /\\([a-zA-Z]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  let run = 0;
  for (let index = match.index; index >= 0 && text[index] === '\\'; index--) run++;
  return run % 2 === 0 ? null : { start: match.index, query: match[1] };
}

export function matchTexCompletions(query: string, limit = 8): TexCompletion[] {
  const rank = (item: TexCompletion, prefix: string, fold: boolean) => {
    const lengths = item.keys.filter(key => (fold ? key.toLowerCase() : key).startsWith(prefix)).map(key => key.length);
    return lengths.length ? Math.min(...lengths) : Infinity;
  };
  const ordered = (fold: boolean, exclude: TexCompletion[]) => {
    const prefix = fold ? query.toLowerCase() : query;
    const matched = TEX_COMPLETIONS.map((item, index) => ({ item, index, rank: rank(item, prefix, fold) })).filter(entry => entry.rank !== Infinity && !exclude.includes(entry.item));
    // Shorter matching names come first, so \pm precedes \pmatrix; an empty query keeps the curated order.
    if (query) matched.sort((first, second) => first.rank - second.rank || first.index - second.index);
    return matched.map(entry => entry.item);
  };
  const exact = ordered(false, []);
  return [...exact, ...ordered(true, exact)].slice(0, limit);
}

/** Replace the typed command between start and caret, returning the new text and caret. */
export function applyTexCompletion(text: string, start: number, caret: number, item: TexCompletion): { text: string; caret: number } {
  return { text: text.slice(0, start) + item.insert + text.slice(caret), caret: start + item.caret };
}
