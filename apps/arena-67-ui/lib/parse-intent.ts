import type { TradeIntent } from './types';

const ADDRESS = /0x[a-fA-F0-9]{40}/;
const CURRENCIES = ['USDG', 'ETH', 'WETH'] as const;

/**
 * A deliberately small local parser for the direct REST path.
 *
 * When the OpenServ agent is enabled the runtime does this extraction properly,
 * against the capability's Zod schema. This exists so the desk is demonstrable
 * without the tunnel, and it is intentionally conservative: anything it is not
 * sure about is left undefined so the backend asks, rather than guessed at.
 *
 * It never turns a ticker into an address. That resolution happens server-side
 * against the pool index, and the user picks.
 */
export function parseIntent(input: string): TradeIntent | null {
  const text = input.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const action: 'buy' | 'sell' | null = /\b(buy|buying|long|ape)\b/.test(lower)
    ? 'buy'
    : /\b(sell|selling|dump|exit)\b/.test(lower)
      ? 'sell'
      : null;
  if (!action) return null;

  const intent: TradeIntent = { action };

  const address = text.match(ADDRESS)?.[0];
  if (address) intent.contractAddress = address;

  const amount = lower.match(/(\d+(?:\.\d+)?)/)?.[1];
  if (amount) {
    const n = Number(amount);
    if (Number.isFinite(n) && n > 0) intent.amount = n;
  }

  const currency = CURRENCIES.find((c) =>
    new RegExp(`\\b${c.toLowerCase()}\\b`).test(lower),
  );
  if (currency) intent.currency = currency;

  if (!address) {
    // Strip the words we've already consumed; whatever's left that looks like
    // a name is the ticker. Better to hand back nothing than a wrong guess —
    // an empty ticker just makes the desk ask which token.
    const ticker = text
      .replace(ADDRESS, ' ')
      .replace(/\b(buy|buying|long|ape|sell|selling|dump|exit)\b/gi, ' ')
      .replace(/\b(of|worth|for|with|in|the|a|an|some|me|please)\b/gi, ' ')
      .replace(/\d+(\.\d+)?/g, ' ')
      .replace(new RegExp(`\\b(${CURRENCIES.join('|')})\\b`, 'gi'), ' ')
      .replace(/[^\w\s$-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\$/, '');
    if (ticker) intent.ticker = ticker;
  }

  return intent;
}

/**
 * Shown in the empty state.
 *
 * These are prompts now, not syntax. The desk used to need "buy X" in a shape
 * a regex recognised; it takes questions, so the examples should invite them
 * rather than teach a grammar that no longer exists.
 */
/**
 * Starter questions. Tapping one sends it, so each has to work as written and
 * show off a different thing the desk can do.
 */
export const EXAMPLES = [
  'What are the most traded tokens today?',
  'What do you know about microduck?',
  'Which wallets hold more than one of the top 10 tokens by volume today?',
  'Show my portfolio',
] as const;
