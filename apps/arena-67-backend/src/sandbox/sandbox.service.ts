import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { DRIZZLE } from '../database/database.constants';
import { dbOf, type Database } from '../database/database.module';
import { paperAccounts, paperBalances, paperDeposits, paperTrades, users } from '../database/schema';
import { ChainService } from '../chain/chain.service';
import { NATIVE_TOKEN } from '../chain/networks';
import { MarketService } from '../market/market.service';
import { LivePriceService } from '../market/live-price.service';
import {
  acquire,
  applyFill,
  assetKey,
  toFloat,
  type FillInput,
  type PaperPosition,
} from './paper-ledger';

export type TradingMode = 'sandbox' | 'live';

/** Largest single top-up, in dollars. Stops absurd numbers, not ambition. */
export const MAX_DEPOSIT_USD = 1_000_000;

export interface PaperHolding {
  address: string;
  symbol: string;
  name: string;
  balance: string;
  priceUsd: number | null;
  valueUsd: number | null;
  imageUrl: string | null;
  /** Cash is ETH and USDG — what trades are paid with. Everything else is a position. */
  kind: 'cash' | 'position';
  /** What the current amount cost. */
  costUsd: number;
  /** Cost ÷ amount: the average price paid per token. Null for cash. */
  avgPriceUsd: number | null;
  /** Value minus cost; null when unpriced. */
  pnlUsd: number | null;
  pnlPct: number | null;
  /** Profit already locked in on this asset by earlier sales. */
  realizedUsd: number;
  /** Share of the whole portfolio's value, 0–100. */
  allocationPct: number | null;
}

/** A token sold down to nothing: what it made or lost in total. */
export interface ClosedPosition {
  address: string;
  symbol: string;
  imageUrl: string | null;
  realizedUsd: number;
}

export interface PaperActivity {
  side: 'buy' | 'sell';
  symbol: string;
  address: string;
  valueUsd: number | null;
  realizedUsd: number | null;
  at: string;
}

export interface PaperPortfolio {
  kind: 'portfolio';
  mode: 'sandbox';
  address: string;
  totalUsd: number;
  unpricedCount: number;
  holdings: PaperHolding[];
  /** Everything deposited since the last reset, valued when deposited. */
  netDepositsUsd: number;
  totalReturnUsd: number;
  totalReturnPct: number | null;
  realizedUsd: number;
  unrealizedUsd: number;
  /** Value in cash (ETH, USDG) and in positions. */
  cashUsd: number;
  investedUsd: number;
  /** Simulated network fees paid, in dollars. */
  feesUsd: number;
  tradeCount: number;
  /** When this paper account (or its last reset) began. */
  startedAt: string;
  closedPositions: ClosedPosition[];
  recentTrades: PaperActivity[];
  asOf: string;
}

export interface PaperFillRecord {
  tradeId: string;
  realizedUsd: number;
}

/**
 * The paper account: balances, deposits, fills and valuation.
 *
 * Never touches the chain beyond reading prices, and never touches the real
 * `trades` table or the user's wallet. The accounting itself is in
 * paper-ledger.ts, pure and tested; this class loads, locks and stores.
 */
@Injectable()
export class SandboxService {
  private readonly log = new Logger(SandboxService.name);
  private readonly db: Database;

  constructor(
    @Inject(DRIZZLE) handle: unknown,
    private readonly chain: ChainService,
    private readonly market: MarketService,
    private readonly livePrice: LivePriceService,
  ) {
    this.db = dbOf(handle);
  }

  // ------------------------------------------------------------------ mode

  async mode(userId: string): Promise<TradingMode> {
    const row = await this.db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { tradingMode: true },
    });
    return (row?.tradingMode as TradingMode) ?? 'sandbox';
  }

  async setMode(userId: string, mode: TradingMode): Promise<TradingMode> {
    await this.db.update(users).set({ tradingMode: mode }).where(eq(users.id, userId));
    return mode;
  }

  // ------------------------------------------------------------- accounts

  /** Current epoch, creating the account on first use. */
  async epoch(userId: string, db: Database = this.db): Promise<number> {
    await db.insert(paperAccounts).values({ userId }).onConflictDoNothing();
    const row = await db.query.paperAccounts.findFirst({ where: eq(paperAccounts.userId, userId) });
    return row?.epoch ?? 1;
  }

  /** ETH, USDG, and anything else in this network's base set, by key. */
  private get weth(): string | undefined {
    return this.chain.network.baseTokens.WETH?.address;
  }

  key(address: string): string {
    return assetKey(address, this.weth);
  }

  async positions(userId: string, db: Database = this.db, epoch?: number): Promise<Map<string, PaperPosition>> {
    const e = epoch ?? (await this.epoch(userId, db));
    const rows = await db
      .select()
      .from(paperBalances)
      .where(and(eq(paperBalances.userId, userId), eq(paperBalances.epoch, e)));
    return new Map(
      rows.map((r) => [
        r.asset,
        {
          asset: r.asset,
          symbol: r.symbol,
          decimals: r.decimals,
          amount: BigInt(r.amount.split('.')[0]),
          costUsd: r.costUsd,
          realizedUsd: r.realizedUsd,
        },
      ]),
    );
  }

  async balanceOf(userId: string, address: string): Promise<bigint> {
    return (await this.positions(userId)).get(this.key(address))?.amount ?? 0n;
  }

  /**
   * Adds paper funds. Valued in dollars at deposit time and recorded, so a
   * top-up is never mistaken for profit.
   */
  async deposit(userId: string, asset: 'ETH' | 'USDG', amount: string): Promise<{ valueUsd: number }> {
    if (!/^\d+(\.\d+)?$/.test(amount.trim()) || Number(amount) <= 0) {
      throw new BadRequestException('Enter an amount greater than zero.');
    }
    const meta =
      asset === 'ETH'
        ? { asset: NATIVE_TOKEN, symbol: 'ETH', decimals: 18 }
        : (() => {
            const u = this.chain.network.baseTokens.USDG;
            if (!u) throw new BadRequestException('USDG is not available on this network.');
            return { asset: u.address.toLowerCase(), symbol: 'USDG', decimals: u.decimals };
          })();

    let units: bigint;
    try {
      units = parseUnits(amount.trim(), meta.decimals);
    } catch {
      throw new BadRequestException(`${asset} takes at most ${meta.decimals} decimal places.`);
    }
    const price = await this.priceUsd(meta.asset);
    if (price == null) {
      throw new BadRequestException(`Cannot price ${asset} right now, so it cannot be added. Try again shortly.`);
    }
    const valueUsd = Number(amount) * price;
    if (valueUsd > MAX_DEPOSIT_USD) {
      throw new BadRequestException(
        `That is about $${Math.round(valueUsd).toLocaleString()}. The most you can add at once is $${MAX_DEPOSIT_USD.toLocaleString()}.`,
      );
    }

    await this.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const epoch = await this.lock(userId, tx);
      const current = (await this.positions(userId, tx, epoch)).get(meta.asset);
      await this.store(userId, epoch, [acquire(current, units, valueUsd, meta)], tx);
      await tx.insert(paperDeposits).values({
        userId,
        epoch,
        asset: meta.asset,
        symbol: meta.symbol,
        amount: units.toString(),
        valueUsd,
      });
    });
    return { valueUsd };
  }

  /** A fresh start: a new epoch with nothing in it. History is kept. */
  async reset(userId: string): Promise<void> {
    await this.epoch(userId);
    await this.db
      .update(paperAccounts)
      .set({ epoch: sql`${paperAccounts.epoch} + 1`, resetAt: new Date() })
      .where(eq(paperAccounts.userId, userId));
  }

  /**
   * Books a fill atomically. The user's account row is locked for the
   * duration, so two confirms at once cannot both spend the same balance.
   * Throws InsufficientPaperFunds without changing anything if it cannot pay.
   */
  async fill(
    userId: string,
    input: FillInput,
    meta: { tokenAddress: string; tokenSymbol: string; poolId: string; fundingAddress: string; fundingSymbol: string },
  ): Promise<PaperFillRecord> {
    return this.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const epoch = await this.lock(userId, tx);
      const before = await this.positions(userId, tx, epoch);
      const { positions, realizedUsd } = applyFill(before, input);

      const changed = [...positions.values()].filter((p) => {
        const b = before.get(p.asset);
        return !b || b.amount !== p.amount || b.costUsd !== p.costUsd || b.realizedUsd !== p.realizedUsd;
      });
      await this.store(userId, epoch, changed, tx);

      const [row] = await tx
        .insert(paperTrades)
        .values({
          userId,
          epoch,
          side: input.side,
          tokenAddress: meta.tokenAddress.toLowerCase(),
          tokenSymbol: meta.tokenSymbol,
          poolId: meta.poolId,
          fundingAddress: meta.fundingAddress.toLowerCase(),
          fundingSymbol: meta.fundingSymbol,
          amountIn: input.amountIn.toString(),
          amountOut: input.amountOut.toString(),
          valueUsd: input.valueUsd,
          feeUsd: input.fee?.usd ?? 0,
          feeAsset: input.fee?.symbol ?? null,
          realizedUsd: input.side === 'sell' ? realizedUsd : null,
        })
        .returning({ id: paperTrades.id });
      return { tradeId: row.id, realizedUsd };
    });
  }

  private async lock(userId: string, tx: Database): Promise<number> {
    await tx.insert(paperAccounts).values({ userId }).onConflictDoNothing();
    const [row] = await tx
      .select({ epoch: paperAccounts.epoch })
      .from(paperAccounts)
      .where(eq(paperAccounts.userId, userId))
      .for('update');
    return row.epoch;
  }

  private async store(userId: string, epoch: number, list: PaperPosition[], tx: Database): Promise<void> {
    for (const p of list) {
      await tx
        .insert(paperBalances)
        .values({
          userId,
          epoch,
          asset: p.asset,
          symbol: p.symbol,
          decimals: p.decimals,
          amount: p.amount.toString(),
          costUsd: p.costUsd,
          realizedUsd: p.realizedUsd,
        })
        .onConflictDoUpdate({
          target: [paperBalances.userId, paperBalances.epoch, paperBalances.asset],
          set: {
            amount: p.amount.toString(),
            costUsd: p.costUsd,
            realizedUsd: p.realizedUsd,
            updatedAt: new Date(),
          },
        });
    }
  }

  // ------------------------------------------------------------ valuation

  /** Dollar price of one whole unit. USDG is $1; ETH from the WETH market. */
  async priceUsd(asset: string): Promise<number | null> {
    const key = this.key(asset);
    const usdg = this.chain.network.baseTokens.USDG?.address.toLowerCase();
    if (key === usdg) return 1;
    const lookup = key === NATIVE_TOKEN ? this.weth : key;
    if (!lookup) return null;
    const m = await this.market.forToken(lookup).catch(() => null);
    return m?.stats?.priceUsd ?? null;
  }

  /**
   * The paper account, valued and explained: what it is worth, how that
   * splits between cash and positions, profit locked in and on paper, fees,
   * each position against what it cost, positions closed out, and the last
   * few trades. Everything the portfolio card needs to answer "how am I
   * doing?" without the reader doing arithmetic.
   */
  async portfolio(userId: string): Promise<PaperPortfolio> {
    const epoch = await this.epoch(userId);
    const [positions, [{ deposits }], [{ fees, trades }], account, recent] = await Promise.all([
      this.positions(userId, this.db, epoch),
      this.db
        .select({ deposits: sql<number>`coalesce(sum(${paperDeposits.valueUsd}), 0)::float8` })
        .from(paperDeposits)
        .where(and(eq(paperDeposits.userId, userId), eq(paperDeposits.epoch, epoch))),
      this.db
        .select({
          fees: sql<number>`coalesce(sum(${paperTrades.feeUsd}), 0)::float8`,
          trades: sql<number>`count(*)::int`,
        })
        .from(paperTrades)
        .where(and(eq(paperTrades.userId, userId), eq(paperTrades.epoch, epoch))),
      this.db.query.paperAccounts.findFirst({ where: eq(paperAccounts.userId, userId) }),
      this.db
        .select()
        .from(paperTrades)
        .where(and(eq(paperTrades.userId, userId), eq(paperTrades.epoch, epoch)))
        .orderBy(desc(paperTrades.createdAt))
        .limit(5),
    ]);

    const usdg = this.chain.network.baseTokens.USDG?.address.toLowerCase();
    const isCash = (asset: string) => asset === NATIVE_TOKEN || asset === usdg;
    const list = [...positions.values()];
    const realizedUsd = list.reduce((s, p) => s + p.realizedUsd, 0);
    // A token worth under a cent with next to no cost left is a leftover
    // speck from selling, not a position; it is shown as sold.
    const dust = (p: PaperPosition) => !isCash(p.asset) && p.costUsd < 0.01;
    const held = list.filter((p) => p.amount > 0n);

    const priced = await Promise.all(
      held.map(async (p) => {
        const native = p.asset === NATIVE_TOKEN;
        const [price, m] = await Promise.all([
          // Positions at the pool's price this block, so a live card's P&L moves
          // with the market; cash at its usual rate.
          isCash(p.asset) ? this.priceUsd(p.asset) : this.positionPrice(p.asset),
          native ? Promise.resolve(null) : this.market.forToken(p.asset).catch(() => null),
        ]);
        const amount = toFloat(p.amount, p.decimals);
        const valueUsd = price == null ? null : amount * price;
        const cash = isCash(p.asset);
        return {
          address: native ? NATIVE_TOKEN : getAddress(p.asset),
          symbol: native ? 'ETH' : m?.symbol || p.symbol,
          name: native ? 'Ether' : m?.name || p.symbol,
          balance: formatUnits(p.amount, p.decimals),
          priceUsd: price,
          valueUsd,
          imageUrl: m?.imageUrl ?? null,
          kind: (cash ? 'cash' : 'position') as PaperHolding['kind'],
          costUsd: p.costUsd,
          avgPriceUsd: !cash && amount > 0 ? p.costUsd / amount : null,
          pnlUsd: valueUsd == null ? null : valueUsd - p.costUsd,
          pnlPct: valueUsd == null || p.costUsd <= 0 ? null : ((valueUsd - p.costUsd) / p.costUsd) * 100,
          realizedUsd: p.realizedUsd,
        };
      }),
    );

    const specks = new Set(
      priced.filter((h, i) => dust(held[i]) && (h.valueUsd ?? 0) < 0.01).map((h) => h.address.toLowerCase()),
    );
    const totalUsd = priced.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
    const holdings: PaperHolding[] = priced
      .filter((h) => !specks.has(h.address.toLowerCase()))
      .map((h) => ({
        ...h,
        allocationPct: h.valueUsd != null && totalUsd > 0 ? (h.valueUsd / totalUsd) * 100 : null,
      }))
      .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

    // Tokens sold down to nothing still made or lost something; the card
    // shows them so a finished trade does not simply vanish.
    const closed = list.filter(
      (p) =>
        (p.amount === 0n || specks.has(p.asset.toLowerCase())) &&
        !isCash(p.asset) &&
        Math.abs(p.realizedUsd) >= 0.005,
    );
    const closedPositions: ClosedPosition[] = await Promise.all(
      closed.map(async (p) => {
        const m = await this.market.forToken(p.asset).catch(() => null);
        return {
          address: getAddress(p.asset),
          symbol: m?.symbol || p.symbol,
          imageUrl: m?.imageUrl ?? null,
          realizedUsd: p.realizedUsd,
        };
      }),
    );
    closedPositions.sort((a, b) => b.realizedUsd - a.realizedUsd);

    const cashUsd = holdings.filter((h) => h.kind === 'cash').reduce((s, h) => s + (h.valueUsd ?? 0), 0);
    const unrealizedUsd = holdings.reduce((s, h) => s + (h.pnlUsd ?? 0), 0);
    const totalReturnUsd = totalUsd - deposits;
    return {
      kind: 'portfolio',
      mode: 'sandbox',
      address: '',
      totalUsd,
      unpricedCount: holdings.filter((h) => h.valueUsd == null).length,
      holdings,
      netDepositsUsd: deposits,
      totalReturnUsd,
      totalReturnPct: deposits > 0 ? (totalReturnUsd / deposits) * 100 : null,
      realizedUsd,
      unrealizedUsd,
      cashUsd,
      investedUsd: totalUsd - cashUsd,
      feesUsd: fees,
      tradeCount: trades,
      startedAt: (account?.resetAt ?? account?.createdAt ?? new Date()).toISOString(),
      closedPositions,
      recentTrades: recent.map((r) => ({
        side: r.side,
        symbol: r.tokenSymbol,
        address: getAddress(r.tokenAddress),
        valueUsd: r.valueUsd,
        realizedUsd: r.realizedUsd,
        at: r.createdAt.toISOString(),
      })),
      asOf: new Date().toISOString(),
    };
  }

  /** Finds a simulated open position by the symbol or name a user typed. */
  async findHeldToken(userId: string, query: string): Promise<PaperHolding | null> {
    const needle = query.trim().replace(/^\$/, '').toLowerCase();
    if (!needle) return null;
    const portfolio = await this.portfolio(userId);
    return (
      portfolio.holdings.find(
        (h) =>
          h.kind === 'position' &&
          (h.symbol.toLowerCase() === needle || h.name.toLowerCase() === needle),
      ) ?? null
    );
  }

  /** A token's on-chain price from its deepest pool, falling back to the market's. */
  private async positionPrice(asset: string): Promise<number | null> {
    const live = await this.livePrice.live(asset).catch(() => null);
    return live?.priceUsd ?? (await this.priceUsd(asset));
  }

  /** Recent paper trades, newest first. */
  async history(userId: string, limit = 20) {
    const epoch = await this.epoch(userId);
    const rows = await this.db
      .select()
      .from(paperTrades)
      .where(and(eq(paperTrades.userId, userId), eq(paperTrades.epoch, epoch)))
      .orderBy(desc(paperTrades.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows.map((r) => ({
      mode: 'sandbox' as const,
      side: r.side,
      token: r.tokenSymbol,
      tokenAddress: r.tokenAddress,
      funding: r.fundingSymbol,
      valueUsd: r.valueUsd,
      feeUsd: r.feeUsd,
      realizedUsd: r.realizedUsd,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
