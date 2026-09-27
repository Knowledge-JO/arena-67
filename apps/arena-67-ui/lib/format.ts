/**
 * Display helpers, with one rule running through all of them: a null is an
 * em-dash, never a zero.
 *
 * The backend deliberately returns null when it cannot price something, and
 * that distinction is the whole point — `$0.00` on a trading screen reads as a
 * fact. Formatting null as a dash is what keeps "we don't know" visible.
 */
const DASH = '—';

export function usd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  if (value === 0) return '$0';
  const abs = Math.abs(value);
  // Memecoin prices routinely need more than two decimals to say anything at
  // all — $0.00 would be every one of them.
  if (abs < 0.000001) return `$${value.toExponential(3)}`;
  if (abs < 1) return `$${value.toPrecision(4)}`;
  if (abs < 1000) return `$${value.toFixed(2)}`;
  return `$${compact(value)}`;
}

export function compact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(0);
}

export function usdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return `$${compact(value)}`;
}

export function percent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/** Tone for a change figure. `null` gets neutral, not green. */
export function changeTone(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) {
    return 'text-fg-muted';
  }
  return value > 0 ? 'text-positive' : 'text-negative';
}

export function count(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return value.toLocaleString();
}

export const DASH_CHAR = DASH;

/**
 * Exact dollars, for money someone is tracking: $1,634.16 rather than $1.6K.
 * Market figures can be compact; a balance and its profit cannot — a $0.36
 * loss next to "$1.6K" hides the one number the person is reading for.
 */
export function usdExact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  // Money is counted in cents. A $0.0049 fee is "<$0.01", not "$0.004880";
  // token *prices* (which do need the digits) use usd() instead.
  // Half a cent and up rounds to the cent ($0.0098 is "$0.01"); only true
  // specks read "<$0.01".
  if (abs > 0 && abs < 0.005) return '<$0.01';
  return `${value < 0 ? '−' : ''}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Signed dollars: +$12.40 / −$0.36. */
export function usdSigned(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  // A rounding-level amount is neither a gain nor a loss.
  if (Math.abs(value) < 0.005) return '$0.00';
  return `${value >= 0 ? '+' : '−'}${usdExact(Math.abs(value))}`;
}

/** Signed percent with enough decimals that a small move is not "0.0%". */
export function pctSigned(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const abs = Math.abs(value);
  const digits = abs >= 10 ? 1 : abs >= 0.1 ? 2 : 3;
  return `${value >= 0 ? '+' : '−'}${abs.toFixed(digits)}%`;
}

/**
 * A token amount for reading, not copying: 11,789,473.85 becomes "11.79M".
 * The exact figure belongs in a tooltip.
 */
export function amountShort(value: string | number): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toPrecision(4).replace(/\.?0+$/, '');
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/**
 * How long ago a token launched, short enough for a sidebar: "45m old",
 * "3h old", "2d old", "4mo old". Launch is when its first trading pool opened
 * — the chain keeps no history to read the contract's own deploy time from.
 */
export function ageShort(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '—';
  const m = Math.max(0, (now - at) / 60_000);
  if (m < 60) return `${Math.max(1, Math.round(m))}m old`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)}h old`;
  const d = h / 24;
  if (d < 60) return `${Math.round(d)}d old`;
  return `${Math.round(d / 30)}mo old`;
}
