import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import { dbOf, type Database } from '../database/database.module';
import { trades } from '../database/schema';

export interface NewTrade {
  userId: string;
  conversationId?: string | null;
  side: 'buy' | 'sell';
  tokenAddress: string;
  tokenSymbol: string;
  poolId: string;
  fundingSymbol: string;
  amountIn: bigint;
}

/**
 * The record of what each user actually traded.
 *
 * Written before broadcast as `pending` and settled after, so a crash mid-swap
 * leaves a row saying a trade may be in flight — rather than no trace of a
 * transaction that did go out and spent someone's money.
 */
@Injectable()
export class TradeLedgerService {
  private readonly db: Database;

  constructor(@Inject(DRIZZLE) handle: unknown) {
    this.db = dbOf(handle);
  }

  async open(t: NewTrade): Promise<string> {
    const [row] = await this.db
      .insert(trades)
      .values({
        userId: t.userId,
        conversationId: t.conversationId ?? null,
        side: t.side,
        tokenAddress: t.tokenAddress,
        tokenSymbol: t.tokenSymbol,
        poolId: t.poolId,
        fundingSymbol: t.fundingSymbol,
        amountIn: t.amountIn.toString(),
        status: 'pending',
      })
      .returning({ id: trades.id });
    return row.id;
  }

  async settle(
    id: string,
    result:
      | { status: 'confirmed'; txHash: string; amountOut: bigint }
      | { status: 'failed'; error: string; txHash?: string },
  ): Promise<void> {
    await this.db
      .update(trades)
      .set(
        result.status === 'confirmed'
          ? { status: 'confirmed', txHash: result.txHash, amountOut: result.amountOut.toString() }
          : { status: 'failed', error: result.error.slice(0, 500), txHash: result.txHash ?? null },
      )
      .where(eq(trades.id, id));
  }

  /** Newest first. Always scoped to one user. */
  history(userId: string, limit = 20) {
    return this.db.query.trades.findMany({
      where: eq(trades.userId, userId),
      orderBy: desc(trades.createdAt),
      limit: Math.min(limit, 100),
    });
  }
}
