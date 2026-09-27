import { foldTransfers, isOverflow, nextSpan, walkLogs, ZERO_ADDRESS, type TransferLog } from './transfer-fold';

const A = '0x000000000000000000000000000000000000000a';
const B = '0x000000000000000000000000000000000000000B';
const T = '0x00000000000000000000000000000000000000ff';

const tx = (from: string, to: string, value: bigint, block = 1n): TransferLog => ({
  address: T,
  blockNumber: block,
  args: { from, to, value },
});

describe('foldTransfers', () => {
  it('turns a mint into a balance and ignores the zero address', () => {
    const d = foldTransfers([tx(ZERO_ADDRESS, A, 100n)]);
    expect(d.get(A)).toBe(100n);
    expect(d.has(ZERO_ADDRESS)).toBe(false);
  });

  it('moves value between holders and lower-cases addresses', () => {
    const d = foldTransfers([tx(ZERO_ADDRESS, A, 100n), tx(A, B, 30n)]);
    expect(d.get(A)).toBe(70n);
    expect(d.get(B.toLowerCase())).toBe(30n);
    expect(d.has(B)).toBe(false);
  });

  it('keeps a holder whose changes cancel out, so an existing row still gets updated', () => {
    const d = foldTransfers([tx(A, B, 5n), tx(B, A, 5n)]);
    expect(d.get(A)).toBe(0n);
    expect(d.get(B.toLowerCase())).toBe(0n);
  });

  it('treats a burn as leaving the holder, not crediting anyone', () => {
    const d = foldTransfers([tx(A, ZERO_ADDRESS, 40n)]);
    expect(d.get(A)).toBe(-40n);
    expect(d.size).toBe(1);
  });

  it('skips zero-value transfers', () => {
    expect(foldTransfers([tx(A, B, 0n)]).size).toBe(0);
  });
});

describe('isOverflow', () => {
  it('recognises the RPC result cap, even nested in a cause', () => {
    const err = { message: 'Missing or invalid parameters.', cause: { details: 'logs matched by query exceeds limit of 10000' } };
    expect(isOverflow(err)).toBe(true);
  });
  it('does not mistake a timeout for the cap', () => {
    expect(isOverflow(new Error('request timed out'))).toBe(false);
  });
});

describe('nextSpan', () => {
  it('doubles through sparse ranges and holds near the cap', () => {
    expect(nextSpan(1000n, 10)).toBe(2000n);
    expect(nextSpan(1000n, 9000)).toBe(1000n);
  });
});

describe('walkLogs', () => {
  const overflow = () => Object.assign(new Error('bad'), { details: 'exceeds limit of 10000' });

  it('halves on overflow, retries the same start, and covers every block exactly once', async () => {
    const seen: Array<[bigint, bigint]> = [];
    await walkLogs<number>({
      from: 0n,
      to: 99n,
      span: 100n,
      sleep: async () => undefined,
      // Anything wider than 30 blocks is "too many logs".
      fetch: async (a, b) => {
        if (b - a + 1n > 30n) throw overflow();
        return [];
      },
      onChunk: async (_l, a, b) => {
        seen.push([a, b]);
      },
    });
    // Contiguous, no gaps, no overlaps.
    expect(seen[0][0]).toBe(0n);
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBe(seen[i - 1][1] + 1n);
    expect(seen[seen.length - 1][1]).toBe(99n);
  });

  it('retries transport errors before shrinking, and gives up at a single block', async () => {
    let calls = 0;
    await expect(
      walkLogs<number>({
        from: 0n,
        to: 3n,
        span: 4n,
        retries: 1,
        sleep: async () => undefined,
        fetch: async () => {
          calls += 1;
          throw new Error('socket hang up');
        },
        onChunk: async () => undefined,
      }),
    ).rejects.toThrow('socket hang up');
    // 4 → 2 → 1, two attempts at each width.
    expect(calls).toBe(6);
  });

  it('does not advance past a chunk whose commit failed', async () => {
    const committed: bigint[] = [];
    await expect(
      walkLogs<number>({
        from: 0n,
        to: 9n,
        span: 5n,
        fetch: async () => [],
        onChunk: async (_l, _a, b) => {
          if (b === 9n) throw new Error('db down');
          committed.push(b);
        },
      }),
    ).rejects.toThrow('db down');
    expect(committed).toEqual([4n]);
  });
});
