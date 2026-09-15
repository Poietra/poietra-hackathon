/** Only literal CSS colors are accepted: authored values must never load SVG resources. */
export function color(value: string, fallback = 'none'): string {
  const candidate = value.trim();
  return /^(?:#[\da-f]{3,4}|#[\da-f]{6}|#[\da-f]{8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-/]+\))$/i.test(candidate)
    && !/^(?:inherit|initial|unset|revert|currentcolor)$/i.test(candidate) ? candidate : fallback;
}

export function escapeXml(value: string): string {
  return value.replace(/\p{Surrogate}/gu, '\uFFFD').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

export function finite(value: number, fallback = 0): number { return Number.isFinite(value) ? value : fallback; }
export function unit(value: number): number { return Math.min(1, Math.max(0, finite(value))); }
export function number(value: number): string { const safe = finite(value); return String(Math.abs(safe) < 1e15 ? Math.round(safe * 1000000) / 1000000 : safe); }

/** Encodes every code point, so different authored prefixes can never collapse to one ID. */
export function safeId(value: string): string { return Array.from(value, character => character.codePointAt(0)!.toString(16)).join('-') || 'empty'; }
