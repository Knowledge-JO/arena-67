import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { getAddress, isAddress, type Address } from 'viem';
import { DRIZZLE } from '../database/database.constants';
import { dbOf, type Database } from '../database/database.module';
import { tokenHolders, tokenIndexState } from '../database/schema';
import { ChainService } from '../chain/chain.service';
import {
  TRANSFER_EVENT,
  byToken,
  foldTransfers,
  walkLogs,
  type TransferLog,
} from './transfer-fold';

export type IndexStatus = 'queued' | 'indexing' | 'ready' | 'failed';

/** Why a token is being indexed. Higher runs first. */
export const PRIORITY = { heldByUser: 1, topVolume: 2, userRequest: 3 } as const;

/** What a caller needs to say how far along a token is. */
export interface HolderIndexProgress {
  token: string;
  status: IndexStatus;
  /** 0–100, by blocks covered. Early blocks are the densest, so it starts slow. */
  percent: number;
  /** Blocks between the index and the chain head; small when live. */
  lagBlocks: number | null;
  transfersSeen: number;
  error: string | null;
}

/**
 * Blocks held back from the head. Robinhood Chain is an Orbit rollup with
 * ~0.1s blocks; two seconds of margin keeps a sequencer reorg from being
 * folded into balances that are never revisited.
 */
const CONFIRMATIONS = 20n;
/** A ready token further behind than this is caught up by the backfill worker, not the tail. */
const MAX_TAIL_LAG = 200_000n;
/**
 * A token at most this far behind is a catch-up — seconds of work — and runs
 * in its own lane. Measured after five hours of downtime: busy tokens caught
 * up in 5–8s each, but sat queued for many minutes behind two first-time
 * backfills of a million transfers apiece.
 */
const QUICK_LAG = 3_000_000n;
const QUICK_SLOTS = 1;
/** Tokens per multi-address tail query. */
const TAIL_BATCH = 50;
const INSERT_BATCH = 1_000;
/** Queue bound. Past it, new requests below user priority are refused. */
const MAX_QUEUED = 300;
const TRACK_FOR_MS = 24 * 3_600_000;

/**
 * Rebuilds who holds each tracked token from its Transfer logs, and keeps it
 * current.
 *
 * Two loops share the table:
 *   - the **backfill** takes one token at a time from a priority queue and
 *     walks its whole history (block 0 → head) in windows that fit the RPC's
 *     10,000-log cap. Busy tokens take minutes; microduck showed 137k
 *     transfers in the first 3% of its life alone.
 *   - the **tail** advances every ready token each minute in a single
 *     multi-address query, which is cheap: a busy token sees a few hundred
 *     transfers an hour once launch day is over.
 *
 * Nothing that answers a user waits on either. Callers read whatever is
 * indexed and report progress for the rest.
 */
@Injectable()
export class HolderIndexService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(HolderIndexService.name);
  private readonly db: Database;
  /** token → priority, for tokens being backfilled right now. */
  private readonly active = new Map<string, number>();
  /** Tokens in the quick lane: already indexed, only catching up. */
  private readonly quick = new Set<string>();
  private tailing = false;
  private pumping = false;
  private head: { block: bigint; at: number } | null = null;
  private stopping = false;

  constructor(
    @Inject(DRIZZLE) handle: unknown,
    private readonly chain: ChainService,
    private readonly config: ConfigService,
  ) {
    this.db = dbOf(handle);
  }

  async onModuleInit(): Promise<void> {
    // A backfill that was running when the process died holds a cursor it
    // committed chunk by chunk. Requeuing resumes from it.
    await this.db
      .update(tokenIndexState)
      .set({ status: 'queued' })
      .where(eq(tokenIndexState.status, 'indexing'));
  }

  onApplicationShutdown(): void {
    this.stopping = true;
  }

  private get concurrency(): number {
    return this.config.get<number>('HOLDER_INDEX_CONCURRENCY') ?? 2;
  }

  /**
   * Asks for a token to be indexed and kept live. Idempotent; the strongest
   * priority wins and tracking is extended, never shortened.
   *
   * Returns false only when the queue is full and this is not a user's
   * request — background interest is the thing to shed under load.
   */
  async request(address: string, priority: number): Promise<boolean> {
    return (await this.requestMany([address], priority)) > 0;
  }

  /**
   * Many tokens in one statement. The database is a network hop away and
   * the overlap question asks about ten tokens at once; one round trip per
   * token per step added up to seconds.
   *
   * Returns how many were accepted.
   */
  async requestMany(addresses: string[], priority: number): Promise<number> {
    const tokens = [...new Set(addresses.filter((a) => isAddress(a)).map((a) => a.toLowerCase()))];
    if (tokens.length === 0) return 0;
    const trackedUntil = new Date(Date.now() + TRACK_FOR_MS);

    let accepted = tokens;
    if (priority < PRIORITY.userRequest) {
      // Background interest is what gets shed under load; a person asking is not.
      const [{ n }] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(tokenIndexState)
        .where(eq(tokenIndexState.status, 'queued'));
      if (n >= MAX_QUEUED) {
        const known = await this.db
          .select({ token: tokenIndexState.token })
          .from(tokenIndexState)
          .where(inArray(tokenIndexState.token, tokens));
        const have = new Set(known.map((k) => k.token));
        accepted = tokens.filter((t) => have.has(t));
        if (accepted.length === 0) return 0;
      }
    }

    const rows = await this.db
      .insert(tokenIndexState)
      .values(accepted.map((token) => ({ token, status: 'queued', priority, trackedUntil })))
      .onConflictDoUpdate({
        target: tokenIndexState.token,
        // Qualified by hand: Postgres calls a bare column in DO UPDATE
        // ambiguous between the existing row and `excluded`.
        set: {
          priority: sql`greatest("token_index_state"."priority", ${priority})`,
          trackedUntil: sql`greatest("token_index_state"."tracked_until", ${trackedUntil.toISOString()}::timestamptz)`,
          requestedAt: sql`now()`,
          // A user asking is the signal to retry a failure right away rather
          // than wait out its backoff.
          nextAttemptAt:
            priority >= PRIORITY.userRequest
              ? sql`null`
              : sql.raw('"token_index_state"."next_attempt_at"'),
        },
      })
      .returning({
        token: tokenIndexState.token,
        status: tokenIndexState.status,
        cursor: tokenIndexState.cursorBlock,
      });

    // A ready token that went untracked and fell far behind is caught up by
    // the backfill, which walks in large windows; the tail would try to do
    // it in one query per minute.
    const head = await this.chainHead().catch(() => null);
    const behind =
      head == null
        ? []
        : rows
            .filter((r) => r.status === 'ready' && r.cursor != null && head - r.cursor > MAX_TAIL_LAG)
            .map((r) => r.token);
    if (behind.length) {
      await this.db
        .update(tokenIndexState)
        .set({ status: 'queued', updatedAt: new Date() })
        .where(inArray(tokenIndexState.token, behind));
    }

    void this.pump();
    return rows.length;
  }

  /** Progress for each token asked about. Tokens never requested are absent. */
  async progress(addresses: string[]): Promise<Map<string, HolderIndexProgress>> {
    const tokens = [...new Set(addresses.map((a) => a.toLowerCase()))];
    const out = new Map<string, HolderIndexProgress>();
    if (tokens.length === 0) return out;

    const rows = await this.db
      .select()
      .from(tokenIndexState)
      .where(inArray(tokenIndexState.token, tokens));
    const head = await this.chainHead().catch(() => null);

    for (const r of rows) {
      out.set(r.token, {
        token: r.token,
        status: r.status as IndexStatus,
        percent: this.percentOf(r, head),
        lagBlocks: head != null && r.cursorBlock != null ? Number(head - r.cursorBlock) : null,
        transfersSeen: r.transfersSeen,
        error: r.status === 'failed' ? r.lastError : null,
      });
    }
    return out;
  }

  private percentOf(
    r: { status: string; fromBlock: bigint | null; cursorBlock: bigint | null },
    head: bigint | null,
  ): number {
    if (r.status === 'ready') return 100;
    if (head == null || r.cursorBlock == null) return 0;
    // Until the first transfer is found the start is unknown; measuring from
    // genesis would claim most of the work is done when none of it is.
    if (r.fromBlock == null) return 0;
    const total = head - r.fromBlock;
    if (total <= 0n) return 99;
    const done = r.cursorBlock - r.fromBlock;
    const pct = Number((done * 1000n) / total) / 10;
    // Never report 100 until the status says so.
    return Math.max(0, Math.min(99, Math.floor(pct)));
  }

  /** Chain head less confirmations, cached briefly: every progress read wants it. */
  async chainHead(): Promise<bigint> {
    if (this.head && Date.now() - this.head.at < 5_000) return this.head.block;
    const block = (await this.chain.client.getBlockNumber()) - CONFIRMATIONS;
    this.head = { block, at: Date.now() };
    return block;
  }

  // ---------------------------------------------------------------- backfill

  /** Starts backfills up to the concurrency limit. Safe to call any time. */
  @Interval(5_000)
  async pump(): Promise<void> {
    // Called from the interval, from request() and from each finishing
    // backfill; two overlapping passes could otherwise claim the same token.
    if (this.stopping || this.pumping) return;
    this.pumping = true;
    try {
      // Quick lane first: catch-ups finish in seconds and should never wait
      // behind a first-time backfill that takes minutes.
      // A failed head read only skips the quick lane this pass; it must not
      // stall the whole queue.
      const head = await this.chainHead().catch(() => null);
      const nearHead = head == null ? null : head - QUICK_LAG;
      while (nearHead != null && this.quick.size < QUICK_SLOTS) {
        const next = await this.nextQueued(0, nearHead);
        if (!next) break;
        this.quick.add(next.token);
        await this.setStatus(next.token, 'indexing');
        void this.backfill(next.token).catch(() => undefined).finally(() => {
          this.quick.delete(next.token);
          void this.pump();
        });
      }

      while (this.active.size < this.concurrency) {
        // One slot is kept for people. Prefetching the top tokens can take
        // minutes each, and someone who just asked should not wait behind it.
        const background = [...this.active.values()].filter((p) => p < PRIORITY.userRequest).length;
        const onlyUsers = background >= Math.max(1, this.concurrency - 1);
        const next = await this.nextQueued(onlyUsers ? PRIORITY.userRequest : 0);
        if (!next) return;
        this.active.set(next.token, next.priority);
        await this.setStatus(next.token, 'indexing');
        void this.backfill(next.token).catch(() => undefined).finally(() => {
          this.active.delete(next.token);
          void this.pump();
        });
      }
    } catch (err) {
      this.log.warn(`holder queue pump failed: ${(err as Error).message}`);
    } finally {
      this.pumping = false;
    }
  }

  /** Next due token; with `nearHead`, only ones already indexed up to at least that block. */
  private async nextQueued(
    minPriority: number,
    nearHead?: bigint,
  ): Promise<{ token: string; priority: number } | null> {
    const due = or(
      eq(tokenIndexState.status, 'queued'),
      // 'indexing' rows this process is not working on are orphans — a
      // failure that could not be recorded. One process runs the indexer, so
      // they are safe to pick up; the ones in progress are filtered below.
      eq(tokenIndexState.status, 'indexing'),
      and(
        eq(tokenIndexState.status, 'failed'),
        or(isNull(tokenIndexState.nextAttemptAt), lte(tokenIndexState.nextAttemptAt, new Date())),
      ),
    );
    const rows = await this.db
      .select({ token: tokenIndexState.token, priority: tokenIndexState.priority })
      .from(tokenIndexState)
      .where(
        and(
          due,
          gte(tokenIndexState.priority, minPriority),
          nearHead != null ? gte(tokenIndexState.cursorBlock, nearHead) : undefined,
        ),
      )
      .orderBy(desc(tokenIndexState.priority), asc(tokenIndexState.requestedAt))
      .limit(this.concurrency + this.active.size + this.quick.size + 1);
    return rows.find((r) => !this.active.has(r.token) && !this.quick.has(r.token)) ?? null;
  }

  private async backfill(token: string): Promise<void> {
    const started = Date.now();
    try {
      const state = await this.db.query.tokenIndexState.findFirst({
        where: eq(tokenIndexState.token, token),
      });
      if (!state) return;

      const target = await this.chainHead();
      const from = state.cursorBlock != null ? state.cursorBlock + 1n : 0n;
      if (from > target) {
        await this.markReady(token);
        return;
      }

      // Fresh token: one window over all of history. An empty prefix costs a
      // single call, and the walk halves its way down to whatever density the
      // launch period needs.
      const span = state.cursorBlock == null ? target - from + 1n : 2_000_000n;

      await walkLogs<TransferLog>({
        from,
        to: target,
        span,
        shouldStop: () => this.stopping,
        fetch: (a, b) =>
          this.chain.client.getLogs({
            address: getAddress(token) as Address,
            event: TRANSFER_EVENT,
            fromBlock: a,
            toBlock: b,
          }) as Promise<TransferLog[]>,
        onChunk: (logs, _a, b) => this.commit(token, logs, b),
      });

      if (this.stopping) return;
      await this.markReady(token);
      const s = await this.db.query.tokenIndexState.findFirst({
        where: eq(tokenIndexState.token, token),
      });
      this.log.log(
        `holders ready for ${token.slice(0, 10)}… — ${s?.transfersSeen ?? 0} transfers in ` +
          `${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
    } catch (err) {
      const message = (err as Error).message?.split('\n')[0] ?? 'unknown error';
      // Recording the failure needs the database too, and when the database
      // is what failed, this must not throw — it once crashed the server.
      try {
        const row = await this.db.query.tokenIndexState.findFirst({
          where: eq(tokenIndexState.token, token),
        });
        const attempts = (row?.attempts ?? 0) + 1;
        // 1, 2, 4 … capped at 30 minutes. The cursor is kept, so a retry
        // resumes rather than starting over.
        const backoffMs = Math.min(30, 2 ** (attempts - 1)) * 60_000;
        await this.db
          .update(tokenIndexState)
          .set({
            status: 'failed',
            lastError: message.slice(0, 300),
            attempts,
            nextAttemptAt: new Date(Date.now() + backoffMs),
            updatedAt: new Date(),
          })
          .where(eq(tokenIndexState.token, token));
      } catch (recordErr) {
        this.log.warn(`could not record failure for ${token}: ${(recordErr as Error).message.split('\n')[0]}`);
      }
      this.log.warn(`holder backfill failed for ${token}: ${message}`);
    }
  }

  /**
   * Folds one chunk into balances and advances the cursor, atomically. If
   * the process dies after this returns, the chunk is counted exactly once;
   * if it dies before, not at all.
   */
  private async commit(token: string, logs: TransferLog[], through: bigint): Promise<void> {
    const deltas = foldTransfers(logs);
    const firstBlock = logs.reduce<bigint | null>(
      (min, l) => (l.blockNumber != null && (min == null || l.blockNumber < min) ? l.blockNumber : min),
      null,
    );

    await this.db.transaction(async (tx) => {
      await this.applyDeltas(tx as unknown as Database, token, deltas, through);
      await tx
        .update(tokenIndexState)
        .set({
          cursorBlock: through,
          transfersSeen: sql`${tokenIndexState.transfersSeen} + ${logs.length}`,
          ...(firstBlock != null
            ? { fromBlock: sql`coalesce(${tokenIndexState.fromBlock}, ${firstBlock})` }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(tokenIndexState.token, token));
    });
  }

  private async applyDeltas(
    db: Database,
    token: string,
    deltas: Map<string, bigint>,
    block: bigint,
  ): Promise<void> {
    if (deltas.size === 0) return;
    const rows = [...deltas.entries()].map(([holder, delta]) => ({
      token,
      holder,
      balance: delta.toString(),
      updatedBlock: block,
    }));

    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      await db
        .insert(tokenHolders)
        .values(rows.slice(i, i + INSERT_BATCH))
        .onConflictDoUpdate({
          target: [tokenHolders.token, tokenHolders.holder],
          set: {
            balance: sql.raw('"token_holders"."balance" + excluded."balance"'),
            updatedBlock: sql.raw('excluded."updated_block"'),
          },
        });
    }

    // Sold out, gone. Keeping zero rows would make the row count lie about
    // how many holders there are.
    await db
      .delete(tokenHolders)
      .where(and(eq(tokenHolders.token, token), eq(tokenHolders.balance, '0')));
  }

  private async markReady(token: string): Promise<void> {
    await this.db
      .update(tokenIndexState)
      .set({ status: 'ready', lastError: null, attempts: 0, nextAttemptAt: null, updatedAt: new Date() })
      .where(eq(tokenIndexState.token, token));
  }

  private async setStatus(token: string, status: IndexStatus): Promise<void> {
    await this.db
      .update(tokenIndexState)
      .set({ status, updatedAt: new Date() })
      .where(eq(tokenIndexState.token, token));
  }

  // -------------------------------------------------------------------- tail

  /**
   * Advances every tracked, ready token to the head. One query per minute
   * covers up to fifty tokens, and each token only takes logs past its own
   * cursor — so tokens that joined at different blocks share a query
   * without double counting.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async tail(): Promise<void> {
    if (this.tailing || this.stopping) return;
    this.tailing = true;
    try {
      const head = await this.chainHead();
      const rows = await this.db
        .select({ token: tokenIndexState.token, cursor: tokenIndexState.cursorBlock })
        .from(tokenIndexState)
        .where(
          and(
            eq(tokenIndexState.status, 'ready'),
            sql`${tokenIndexState.trackedUntil} > now()`,
          ),
        );

      const live: Array<{ token: string; cursor: bigint }> = [];
      for (const r of rows) {
        if (r.cursor == null) continue;
        if (head - r.cursor > MAX_TAIL_LAG) await this.setStatus(r.token, 'queued');
        else if (r.cursor < head) live.push({ token: r.token, cursor: r.cursor });
      }

      for (let i = 0; i < live.length; i += TAIL_BATCH) {
        await this.tailBatch(live.slice(i, i + TAIL_BATCH), head);
      }
    } catch (err) {
      this.log.warn(`holder tail failed, will retry: ${(err as Error).message.split('\n')[0]}`);
    } finally {
      this.tailing = false;
    }
  }

  private async tailBatch(batch: Array<{ token: string; cursor: bigint }>, head: bigint) {
    const cursors = new Map(batch.map((b) => [b.token, b.cursor]));
    const from = batch.reduce((m, b) => (b.cursor < m ? b.cursor : m), head) + 1n;

    await walkLogs<TransferLog>({
      from,
      to: head,
      span: 20_000n,
      shouldStop: () => this.stopping,
      fetch: (a, b) =>
        this.chain.client.getLogs({
          address: batch.map((t) => getAddress(t.token) as Address),
          event: TRANSFER_EVENT,
          fromBlock: a,
          toBlock: b,
        }) as Promise<TransferLog[]>,
      onChunk: async (logs, _a, through) => {
        const grouped = byToken(logs);
        await this.db.transaction(async (tx) => {
          for (const [token, cursor] of cursors) {
            if (cursor >= through) continue;
            const fresh = (grouped.get(token) ?? []).filter(
              (l) => l.blockNumber != null && l.blockNumber > cursor,
            );
            await this.applyDeltas(tx as unknown as Database, token, foldTransfers(fresh), through);
            await tx
              .update(tokenIndexState)
              .set({
                cursorBlock: through,
                transfersSeen: sql`${tokenIndexState.transfersSeen} + ${fresh.length}`,
                updatedAt: new Date(),
              })
              .where(eq(tokenIndexState.token, token));
            cursors.set(token, through);
          }
        });
      },
    });
  }
}
