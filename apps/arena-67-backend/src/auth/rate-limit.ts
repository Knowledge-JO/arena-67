/**
 * A fixed-window counter, in memory.
 *
 * Code requests need a limit or the endpoint becomes a free way to fill
 * someone's inbox, and a cheap way to probe for accounts. In-memory is right
 * for a single process; it resets on restart and does not share across
 * instances, which is the thing to replace with Redis if this ever scales out.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit; returns seconds to wait, or 0 if allowed. */
  take(key: string): number {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return 0;
    }
    if (entry.count >= this.limit) {
      return Math.ceil((entry.resetAt - now) / 1000);
    }
    entry.count += 1;
    return 0;
  }

  private sweep(now: number): void {
    if (this.hits.size < 1000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
