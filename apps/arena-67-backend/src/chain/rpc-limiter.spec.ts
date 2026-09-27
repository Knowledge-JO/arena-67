import { RpcLimiter } from './rpc-limiter';

/** A request that stays in flight until released. */
function held() {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  return { work: () => done, release };
}

describe('RpcLimiter', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('never has more in flight than allowed', async () => {
    const limiter = new RpcLimiter({ maxConcurrent: 2, maxPerSecond: 100, maxBackground: 2 });
    let peak = 0;
    let inFlight = 0;
    const jobs = Array.from({ length: 6 }, () =>
      limiter.run(false, async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
      }),
    );
    await Promise.all(jobs);
    expect(peak).toBe(2);
  });

  it('spreads starts across seconds when the per-second budget is spent', async () => {
    const limiter = new RpcLimiter({ maxConcurrent: 10, maxPerSecond: 3, maxBackground: 10 });
    const starts: number[] = [];
    const jobs = Array.from({ length: 5 }, () =>
      limiter.run(false, async () => {
        starts.push(Date.now());
      }),
    );
    await jest.advanceTimersByTimeAsync(1100);
    await Promise.all(jobs);
    const first = starts[0];
    expect(starts.filter((s) => s - first < 1000)).toHaveLength(3);
    expect(starts).toHaveLength(5);
  });

  it('lets a person’s request past queued background work', async () => {
    const limiter = new RpcLimiter({ maxConcurrent: 1, maxPerSecond: 100, maxBackground: 1 });
    const order: string[] = [];
    const blocker = held();
    const first = limiter.run(true, blocker.work);
    const bg = limiter.run(true, async () => void order.push('background'));
    const fg = limiter.run(false, async () => void order.push('interactive'));
    blocker.release();
    await Promise.all([first, bg, fg]);
    expect(order).toEqual(['interactive', 'background']);
  });

  it('caps background work so interactive requests always have room', async () => {
    const limiter = new RpcLimiter({ maxConcurrent: 3, maxPerSecond: 100, maxBackground: 1 });
    const a = held();
    const b = held();
    const bg1 = limiter.run(true, a.work);
    let bg2Started = false;
    const bg2 = limiter.run(true, async () => void (bg2Started = true));
    let fgStarted = false;
    const fg = limiter.run(false, async () => void (fgStarted = true));
    await Promise.resolve();
    expect(bg2Started).toBe(false); // background share is full
    expect(fgStarted).toBe(true); // a person still gets through
    a.release();
    b.release();
    await Promise.all([bg1, bg2, fg]);
    expect(bg2Started).toBe(true);
  });

  it('passes errors through and frees the slot', async () => {
    const limiter = new RpcLimiter({ maxConcurrent: 1, maxPerSecond: 100, maxBackground: 1 });
    await expect(limiter.run(false, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.run(false, async () => 'ok')).resolves.toBe('ok');
  });
});
