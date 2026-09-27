/**
 * One budget for every request the backend sends to the RPC.
 *
 * Measured against the public Robinhood Chain RPC: about fifteen requests at
 * once succeed and thirty at once get half refused with 429, while a steady
 * 10–25 a second mostly passes. So what trips it is bursts — the holder
 * backfill, the swap tail, the pool index and the holdings scanner all waking
 * on the same minute — not the average. Two limits follow from that: how many
 * requests are in flight at once, and how many start in any one second.
 *
 * Work is in two classes. Interactive requests — quotes, trades, live prices,
 * a report someone is waiting for — always go first. Background work
 * (indexing, tailing, scanning) gets a capped share of the in-flight slots, so
 * a busy indexer can never crowd out a person's trade.
 */
export interface RpcLimits {
  /** Requests in flight at once, both classes together. */
  maxConcurrent: number;
  /** Requests started in any rolling second. */
  maxPerSecond: number;
  /** In-flight slots background work may hold. */
  maxBackground: number;
}

interface Waiter {
  background: boolean;
  start: () => void;
}

export class RpcLimiter {
  private active = 0;
  private activeBackground = 0;
  private readonly started: number[] = [];
  private readonly waiting: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly limits: RpcLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs `work` when the budget allows, releasing its slot when it settles. */
  run<T>(background: boolean, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({
        background,
        start: () => {
          work()
            .then(resolve, reject)
            .finally(() => {
              this.active -= 1;
              if (background) this.activeBackground -= 1;
              this.drain();
            });
        },
      });
      this.drain();
    });
  }

  /** Requests queued, for diagnostics. */
  get queued(): number {
    return this.waiting.length;
  }

  private drain(): void {
    const t = this.now();
    while (this.started.length && t - this.started[0] >= 1000) this.started.shift();

    while (this.waiting.length && this.active < this.limits.maxConcurrent) {
      if (this.started.length >= this.limits.maxPerSecond) {
        // Try again when the oldest start in the window ages out.
        this.schedule(1000 - (t - this.started[0]) + 1);
        return;
      }
      // Interactive work first; background only within its share.
      let i = this.waiting.findIndex((w) => !w.background);
      if (i === -1) {
        if (this.activeBackground >= this.limits.maxBackground) return;
        i = 0;
      }
      const [next] = this.waiting.splice(i, 1);
      this.active += 1;
      if (next.background) this.activeBackground += 1;
      this.started.push(t);
      next.start();
    }
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, Math.max(1, ms));
  }
}
