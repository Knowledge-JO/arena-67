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
