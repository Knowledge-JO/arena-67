import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { eq, sql } from 'drizzle-orm';
import { parseAbiItem } from 'viem';
import { DRIZZLE } from '../database/database.constants';
import { dbOf, type Database } from '../database/database.module';
import { syncState, wallets, walletTokens } from '../database/schema';
import { ChainService } from '../chain/chain.service';

const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const CURSOR_KEY = 'holdings_cursor';
/**
 * Measured: this RPC accepts a Transfer query with no contract address up to
 * ~10,000 blocks and rejects 50,000 with "missing or invalid parameters".
 * Chunks stay under that ceiling with room to spare.
 */
const CHUNK = 8_000n;
/** Topic filters accept a list; kept modest so one query stays well-formed. */
const ADDRESSES_PER_QUERY = 200;

/**
 * Finds which tokens each user's wallet has received.
 *
 * The obvious approach — scan a wallet's history when its portfolio is asked
 * for — does not work here: the RPC caps address-less log queries at about
 * ten thousand blocks (≈17 minutes of chain), so a week-old wallet would need
 * around six hundred queries on its first portfolio load.
 *
 * What makes this tractable is that we create every wallet ourselves. None
 * can have received anything before it existed, so one cursor scanning forward
 * from the moment this service first ran is complete for every wallet —
 * there is never a history to backfill. Each chunk is a single query covering
 * all wallets at once, since `to` is an indexed topic and accepts a list.
 */
@Injectable()
export class HoldingsScannerService implements OnModuleInit {
  private readonly log = new Logger(HoldingsScannerService.name);
  private readonly db: Database;
  private running = false;

  constructor(
    @Inject(DRIZZLE) handle: unknown,
    private readonly chain: ChainService,
  ) {
    this.db = dbOf(handle);
  }

  async onModuleInit(): Promise<void> {
    // Not fatal if the chain is unreachable at boot: tick() tries again.
    await this.initCursor().catch((e: Error) =>
      this.log.warn(`holdings cursor not initialised yet: ${e.message.split('\n')[0]}`),
    );
  }

  /** First ever run: start at the current head. Earlier blocks cannot hold
   * transfers to wallets that did not exist yet. */
  private async initCursor(): Promise<boolean> {
    if ((await this.cursor()) !== null) return true;
    const head = await this.chain.latestBlock();
    await this.setCursor(head);
    this.log.log(`holdings cursor initialised at block ${head}`);
    return true;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return; // a slow scan must not overlap the next tick
    this.running = true;
    try {
      await this.initCursor();
      await this.scan();
    } catch (err) {
      this.log.warn(`holdings scan failed, will resume: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Scans from the cursor to head. Safe to call directly, e.g. before a portfolio read. */
  async scan(): Promise<void> {
    const from = (await this.cursor()) ?? (await this.chain.latestBlock());
    const head = await this.chain.latestBlock();
    if (head <= from) return;

    const addresses = (
      await this.db.select({ address: wallets.address }).from(wallets)
    ).map((w) => w.address as `0x${string}`);

    if (addresses.length === 0) {
      await this.setCursor(head);
      return;
    }

    for (let start = from + 1n; start <= head; start += CHUNK) {
      const end = start + CHUNK - 1n > head ? head : start + CHUNK - 1n;

      for (let i = 0; i < addresses.length; i += ADDRESSES_PER_QUERY) {
        const batch = addresses.slice(i, i + ADDRESSES_PER_QUERY);
        const logs = await this.chain.backgroundClient.getLogs({
          event: TRANSFER,
          args: { to: batch },
          fromBlock: start,
          toBlock: end,
        });
        await this.record(logs);
      }

      // Advance only once the whole chunk is recorded, so a failure part-way
      // resumes at this chunk rather than skipping transfers inside it.
      await this.setCursor(end);
    }
  }

  private async record(
    logs: Array<{ address: string; blockNumber: bigint | null; args: { to?: string } }>,
  ): Promise<void> {
    const rows = logs
      .filter((l) => l.args.to)
      .map((l) => ({
        walletAddress: l.args.to!.toLowerCase(),
        tokenAddress: l.address.toLowerCase(),
        firstSeenBlock: l.blockNumber ?? 0n,
      }));
    if (rows.length === 0) return;
    // A token received many times needs recording once.
    await this.db.insert(walletTokens).values(rows).onConflictDoNothing();
  }

  async tokensFor(address: string): Promise<string[]> {
    const rows = await this.db
      .select({ token: walletTokens.tokenAddress })
      .from(walletTokens)
      .where(eq(walletTokens.walletAddress, address.toLowerCase()));
    return rows.map((r) => r.token);
  }

  private async cursor(): Promise<bigint | null> {
    const row = await this.db.query.syncState.findFirst({
      where: eq(syncState.key, CURSOR_KEY),
    });
    return row ? BigInt(row.value) : null;
  }

  private async setCursor(block: bigint): Promise<void> {
    await this.db
      .insert(syncState)
      .values({ key: CURSOR_KEY, value: block.toString() })
      .onConflictDoUpdate({
        target: syncState.key,
        set: { value: block.toString(), updatedAt: sql`now()` },
      });
  }
}
