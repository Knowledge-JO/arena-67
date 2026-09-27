import { NATIVE_TOKEN } from '../chain/networks';

/** One asset held in a paper account. Amounts in base units. */
export interface PaperPosition {
  asset: string;
  symbol: string;
  decimals: number;
  amount: bigint;
  /** What the current amount cost, in dollars. */
  costUsd: number;
  /** Profit locked in by disposals, in dollars. */
  realizedUsd: number;
}

export class InsufficientPaperFunds extends Error {
  constructor(
    readonly symbol: string,
    readonly held: bigint,
    readonly needed: bigint,
    readonly decimals: number,
  ) {
    super(`Not enough ${symbol} in your sandbox.`);
  }
}

/**
 * The key an asset is stored under. ETH and WETH share one paper balance:
 * on mainnet they are separate assets that need wrapping, which in a sandbox
 * would only stop people trading WETH pools for no teaching value.
 */
export function assetKey(address: string, weth?: string): string {
  const a = address.toLowerCase();
  if (a === NATIVE_TOKEN || (weth && a === weth.toLowerCase())) return NATIVE_TOKEN;
  return a;
}

/**
 * Takes `units` out of a position that yields `proceedsUsd`.
 *
 * Average cost: the share of cost leaving with the units is cost × units /
 * held, and realised profit is proceeds minus that. A fee is a disposal with
 * zero proceeds, so it lands as a realised loss — where it belongs.
 */
export function dispose(pos: PaperPosition | undefined, units: bigint, proceedsUsd: number, meta: { symbol: string; decimals: number }): PaperPosition {
  const held = pos?.amount ?? 0n;
  if (units <= 0n) return pos ?? empty(meta, '');
  if (!pos || held < units) {
    throw new InsufficientPaperFunds(pos?.symbol ?? meta.symbol, held, units, pos?.decimals ?? meta.decimals);
  }
  const share = held === 0n ? 0 : ratio(units, held);
  const costOut = pos.costUsd * share;
  const remaining = held - units;
  return {
    ...pos,
    amount: remaining,
    // Fully sold means no cost left; floating residue must not linger.
    costUsd: remaining === 0n ? 0 : pos.costUsd - costOut,
    realizedUsd: pos.realizedUsd + (proceedsUsd - costOut),
  };
}

/** Adds `units` bought for `valueUsd` to a position (creating it if needed). */
export function acquire(
  pos: PaperPosition | undefined,
  units: bigint,
  valueUsd: number,
  meta: { asset: string; symbol: string; decimals: number },
): PaperPosition {
  const base = pos ?? empty(meta, meta.asset);
  return { ...base, amount: base.amount + units, costUsd: base.costUsd + valueUsd };
}

function empty(meta: { symbol: string; decimals: number }, asset: string): PaperPosition {
  return { asset, symbol: meta.symbol, decimals: meta.decimals, amount: 0n, costUsd: 0, realizedUsd: 0 };
}

/** a / b as a float, without losing precision on large uint256 values. */
export function ratio(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  const scale = 10n ** 18n;
  return Number((a * scale) / b) / 1e18;
}

/** Human units as a float, for pricing. */
export function toFloat(units: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(units / scale) + Number(units % scale) / Number(scale);
}

export interface FillInput {
  side: 'buy' | 'sell';
  token: { asset: string; symbol: string; decimals: number };
  funding: { asset: string; symbol: string; decimals: number };
  amountIn: bigint;
  amountOut: bigint;
  /** Dollar value of the trade: the funding side, at fill time. */
  valueUsd: number;
  /**
   * Simulated network fee, charged to `fee.asset` (normally ETH). Its dollar
   * value leaves with it as a zero-proceeds disposal.
   */
  fee: { asset: string; symbol: string; decimals: number; units: bigint; usd: number } | null;
}

export interface FillResult {
  positions: Map<string, PaperPosition>;
  /** Profit locked in by this trade — the sold side's gain or loss. */
  realizedUsd: number;
}

/**
 * Applies one fill to a set of positions and returns the new set.
 *
 * A buy disposes of funding (proceeds = the trade's value) and acquires the
 * token at that value. A sell is the mirror. Both legs go through the same
 * two functions, so ETH bought low and spent high shows a gain on ETH too —
 * the same accounting a real portfolio gets.
 */
export function applyFill(current: Map<string, PaperPosition>, fill: FillInput): FillResult {
  const next = new Map(current);
  const spend = fill.side === 'buy' ? fill.funding : fill.token;
  const receive = fill.side === 'buy' ? fill.token : fill.funding;

  // The fee first, so a balance that covers the trade but not the fee fails
  // before anything moves — same order as a real transaction.
  if (fill.fee && fill.fee.units > 0n) {
    const needed =
      fill.fee.asset === spend.asset ? fill.fee.units + fill.amountIn : fill.fee.units;
    const held = next.get(fill.fee.asset)?.amount ?? 0n;
    if (held < needed) {
      const pos = next.get(fill.fee.asset);
      throw new InsufficientPaperFunds(pos?.symbol ?? fill.fee.symbol, held, needed, pos?.decimals ?? fill.fee.decimals);
    }
    next.set(fill.fee.asset, dispose(next.get(fill.fee.asset), fill.fee.units, 0, fill.fee));
  }

  const before = next.get(spend.asset)?.realizedUsd ?? 0;
  const spent = dispose(next.get(spend.asset), fill.amountIn, fill.valueUsd, spend);
  next.set(spend.asset, spent);
  next.set(receive.asset, acquire(next.get(receive.asset), fill.amountOut, fill.valueUsd, receive));

  return { positions: next, realizedUsd: spent.realizedUsd - before };
}
