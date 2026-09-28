import { parseAbiItem } from 'viem';

export const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface TransferLog {
  address: string;
  blockNumber: bigint | null;
  args: { from?: string; to?: string; value?: bigint };
}

/**
 * Folds transfers into per-holder balance changes.
 *
 * The zero address is skipped on both sides. A mint is a transfer *from* it
 * and a burn a transfer *to* it; counting it as a holder would give it a
 * large negative balance that means nothing — its role is already captured
 * by totalSupply moving.
 *
 * Holders whose changes cancel out are kept with a zero delta, not dropped:
 * a round trip within one chunk still has to reach the database, since the
 * row may already exist with a balance from an earlier chunk.
 */
export function foldTransfers(logs: TransferLog[]): Map<string, bigint> {
  const deltas = new Map<string, bigint>();
  const add = (who: string | undefined, amount: bigint) => {
    if (!who) return;
    const key = who.toLowerCase();
    if (key === ZERO_ADDRESS) return;
    deltas.set(key, (deltas.get(key) ?? 0n) + amount);
  };

  for (const log of logs) {
    const value = log.args.value ?? 0n;
    if (value === 0n) continue;
    add(log.args.from, -value);
    add(log.args.to, value);
  }
  return deltas;
}

/** Groups logs by the token contract that emitted them, lower-cased. */
export function byToken<T extends { address: string }>(logs: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const log of logs) {
    const key = log.address.toLowerCase();
    const list = out.get(key);
    if (list) list.push(log);
    else out.set(key, [log]);
  }
  return out;
}

/**
 * The RPC's two limits, both measured. "logs matched by query exceeds limit
 * of 10000" caps results; "query spans N blocks … only 10000000 are allowed;
 * narrow the block range" caps the range (added later — the chain is past
 * 75M blocks, so a query from block 0 is always refused now). Either way the
 * answer is a smaller window, straight away rather than after retries.
 */
export function isOverflow(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 5; depth++) {
    const text = [
      (e as { details?: string }).details,
      (e as { message?: string }).message,
    ]
      .filter(Boolean)
      .join(' ');
    if (/exceeds limit|too many|query returned more than|narrow the block range|are allowed for this request/i.test(text)) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export const MIN_SPAN = 1n;
/** The RPC refuses a getLogs spanning more than ten million blocks. */
export const MAX_SPAN = 10_000_000n;
/** Under this many logs a chunk is sparse and the window can grow. */
const GROW_BELOW = 2_500;

/**
 * Next window after a successful chunk. Doubles through sparse history,
 * holds steady near the cap. Shrinking happens on overflow, not here.
 */
export function nextSpan(span: bigint, logsReturned: number): bigint {
  if (logsReturned >= GROW_BELOW) return span;
  const doubled = span * 2n;
  return doubled > MAX_SPAN ? MAX_SPAN : doubled;
}

export interface WalkOptions<L> {
  from: bigint;
  to: bigint;
  span: bigint;
  fetch: (from: bigint, to: bigint) => Promise<L[]>;
  /**
   * Called once per chunk, in order, and awaited: the caller commits the chunk
   * and its cursor together before the walk moves on.
   */
  onChunk: (logs: L[], from: bigint, to: bigint) => Promise<void>;
  /** Transport failures tolerated per chunk before giving up. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
}

/**
 * Walks a block range in windows that fit the RPC's result cap.
 *
 * Overflow halves the window and retries the same start. Other failures are
 * retried with backoff, then treated as overflow — a dense range can time out
 * before it ever reports the cap — and only a window that fails at a single
 * block is fatal.
 */
export async function walkLogs<L>(opts: WalkOptions<L>): Promise<bigint> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retries = opts.retries ?? 3;
  let span = opts.span < MIN_SPAN ? MIN_SPAN : opts.span > MAX_SPAN ? MAX_SPAN : opts.span;
  let start = opts.from;
  let failures = 0;

  while (start <= opts.to) {
    if (opts.shouldStop?.()) break;
    const end = start + span - 1n > opts.to ? opts.to : start + span - 1n;

    let logs: L[];
    try {
      logs = await opts.fetch(start, end);
    } catch (err) {
      if (isOverflow(err) || failures >= retries) {
        if (span === MIN_SPAN) throw err;
        span = span / 2n < MIN_SPAN ? MIN_SPAN : span / 2n;
        failures = 0;
        continue;
      }
      failures += 1;
      await sleep(500 * 2 ** failures);
      continue;
    }

    failures = 0;
    await opts.onChunk(logs, start, end);
    span = nextSpan(span, logs.length);
    start = end + 1n;
  }
  return span;
}
