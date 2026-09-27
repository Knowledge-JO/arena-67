import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { formatUnits, getAddress, isAddress, parseAbi, type Address } from 'viem';
import { DRIZZLE } from '../database/database.constants';
import { dbOf, type Database } from '../database/database.module';
import { tokenHolders, tokenIndexState } from '../database/schema';
import { ChainService } from '../chain/chain.service';
import { MarketService } from '../market/market.service';
import { AddressLabelService, type HolderLabel } from './address-label.service';
import {
  HolderIndexService,
  PRIORITY,
  type HolderIndexProgress,
  type IndexStatus,
} from './holder-index.service';

const TOKEN_ABI = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
]);

/** How deep the breakdown looks. Pools and burns sit at the top, so this sees them. */
const BREAKDOWN_DEPTH = 100;
const SUPPLY_TTL_MS = 60_000;
const RANKED_TTL_MS = 60_000;
/** Indexed balances further than this from totalSupply are reported, not trusted. */
const DRIFT_TOLERANCE = 0.01;
export const MAX_OVERLAP_TOKENS = 20;
export const MAX_TOP_N = 100;

export interface SupplyInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply: bigint;
  /** Null when the contract has no owner() — not the same as renounced. */
  owner: string | null;
}

export interface HolderRow {
  rank: number;
  address: string;
  label: HolderLabel;
  labelName: string | null;
  /** Human units, as a decimal string. */
  balance: string;
  /** Share of total supply, 0–100. Null if supply is zero. */
  percent: number | null;
}

export interface HolderBreakdown {
  /** The ten largest *wallets*, summed. Pools, burns and contracts excluded. */
  top10WalletsPercent: number | null;
  poolsPercent: number | null;
  burnedPercent: number | null;
  contractsPercent: number | null;
  /** The breakdown is computed over this many largest holders. */
  basis: number;
}

export type HoldersStatus = IndexStatus | 'not_indexed' | 'unavailable';

/** The holders section of a report, or the answer to "who holds this". */
export interface HoldersBlock {
  status: HoldersStatus;
  /** Indexing progress 0–100; 100 when ready. */
  progress: number;
  error: string | null;
  holderCount: number | null;
  top: HolderRow[];
  breakdown: HolderBreakdown | null;
  /**
   * Set when indexed balances do not add up to totalSupply — a rebasing or
   * fee-on-transfer token, or one that mints without emitting Transfer. The
   * top holders are still exact (re-read from the chain); counts are not.
   */
  drift: { indexedPercentOfSupply: number } | null;
  /** Block the index covers up to. */
  asOfBlock: string | null;
}

export interface OverlapToken {
  address: string;
  symbol: string;
  status: HoldersStatus;
  progress: number;
  /** How many of its holders were compared. */
  holdersCompared: number;
}

export interface OverlapHolder {
  address: string;
  tokens: Array<{ address: string; symbol: string; percent: number | null; rank: number }>;
}

/** Tokens a single address holds, among the ones we have indexed. */
export interface WalletHolding {
  token: string;
  symbol: string;
  name: string;
  balance: string;
  percent: number | null;
  valueUsd: number | null;
  priceUsd: number | null;
}

/**
 * Answers holder questions from the index, and says plainly when it cannot
 * yet.
 *
 * The index finds candidates; the chain has the last word. Every holder shown
 * is re-read with `balanceOf` in one multicall, so a rebasing token or a
 * missed transfer cannot put a wrong number in front of someone. What the
 * index alone decides — who is in the top N, how many holders there are —
 * carries the drift flag when its totals disagree with the token's own.
 */
@Injectable()
export class HoldersService {
  private readonly log = new Logger(HoldersService.name);
  private readonly db: Database;
  private readonly supplyCache = new Map<string, { at: number; value: SupplyInfo | null }>();
  /**
   * Ranked holders per token, briefly. A report and then "who else holds
   * this" ask for the same list seconds apart, and each fresh build is a
   * database read, a label lookup and a multicall. The index itself only
   * moves once a minute.
   */
  private readonly rankedCache = new Map<string, { at: number; depth: number; rows: HolderRow[] }>();

  constructor(
    @Inject(DRIZZLE) handle: unknown,
    private readonly chain: ChainService,
    private readonly index: HolderIndexService,
    private readonly labels: AddressLabelService,
    private readonly market: MarketService,
  ) {
    this.db = dbOf(handle);
  }

  /** ERC-20 identity and supply, or null if the address does not behave like one. */
  async supply(address: string): Promise<SupplyInfo | null> {
    if (!isAddress(address)) return null;
    const key = address.toLowerCase();
    const hit = this.supplyCache.get(key);
    if (hit && Date.now() - hit.at < SUPPLY_TTL_MS) return hit.value;

    const token = getAddress(address) as Address;
    let value: SupplyInfo | null = null;
    try {
      const r = await this.chain.client.multicall({
        multicallAddress: this.chain.network.multicall3,
        allowFailure: true,
        contracts: (['totalSupply', 'decimals', 'symbol', 'name', 'owner'] as const).map(
          (functionName) => ({ address: token, abi: TOKEN_ABI, functionName }) as const,
        ),
      });
      const [supply, decimals, symbol, name, owner] = r;
      if (supply.status === 'success' && decimals.status === 'success') {
        value = {
          address: token,
          totalSupply: supply.result as bigint,
          decimals: Number(decimals.result),
          symbol: symbol.status === 'success' ? String(symbol.result) : '',
          name: name.status === 'success' ? String(name.result) : '',
          owner: owner.status === 'success' ? String(owner.result).toLowerCase() : null,
        };
      }
    } catch (err) {
      // Not cached: a transport failure is not an answer about the token.
      this.log.warn(`supply read failed for ${token}: ${(err as Error).message.split('\n')[0]}`);
      return null;
    }
    this.supplyCache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * The holders section for one token. Queues indexing when needed and never
   * waits for it.
   */
  async holders(
    address: string,
    opts: { limit?: number; include?: HolderLabel[]; request?: boolean } = {},
  ): Promise<HoldersBlock> {
    const token = address.toLowerCase();
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), MAX_TOP_N);
    const empty = (status: HoldersStatus, extra: Partial<HoldersBlock> = {}): HoldersBlock => ({
      status,
      progress: 0,
      error: null,
      holderCount: null,
      top: [],
      breakdown: null,
      drift: null,
      asOfBlock: null,
      ...extra,
    });

    // Checked before queuing: an address that is not a token must not take a
    // place in the indexer's queue.
    const info = await this.supply(token);
    if (!info) return empty('unavailable', { error: 'Could not read the token from the chain.' });

    if (opts.request !== false) await this.index.request(token, PRIORITY.userRequest);
    const progress = (await this.index.progress([token])).get(token);
    if (!progress) return empty('not_indexed');
    if (progress.status !== 'ready') {
      return empty(progress.status, { progress: progress.percent, error: progress.error });
    }

    // Independent reads, run together — each is a round trip to a database
    // or an RPC that may be far away.
    const [ranked, [{ n, total }], state] = await Promise.all([
      this.rankedHolders(token, info, BREAKDOWN_DEPTH),
      this.db
        .select({
          n: sql<number>`count(*)::int`,
          total: sql<string>`coalesce(sum(${tokenHolders.balance}), 0)::text`,
        })
        .from(tokenHolders)
        .where(and(eq(tokenHolders.token, token), sql`${tokenHolders.balance} > 0`)),
      this.db.query.tokenIndexState.findFirst({ where: eq(tokenIndexState.token, token) }),
    ]);
    const include = opts.include ? new Set(opts.include) : null;
    const top = ranked
      .filter((h) => !include || include.has(h.label))
      .slice(0, limit)
      .map((h, i) => ({ ...h, rank: i + 1 }));

    return {
      status: 'ready',
      progress: 100,
      error: null,
      holderCount: n,
      top,
      breakdown: this.breakdown(ranked),
      drift: this.drift(BigInt(total.split('.')[0]), info.totalSupply),
      asOfBlock: state?.cursorBlock?.toString() ?? null,
    };
  }

  /**
   * The largest holders, labelled and re-read from the chain, largest first.
   * Every label is kept; filtering is the caller's business.
   */
  private async rankedHolders(token: string, info: SupplyInfo, depth: number): Promise<HolderRow[]> {
    const hit = this.rankedCache.get(token);
    if (hit && hit.depth >= depth && Date.now() - hit.at < RANKED_TTL_MS) {
      return hit.rows.slice(0, depth);
    }
    const rows = await this.buildRanked(token, info, depth);
    this.rankedCache.set(token, { at: Date.now(), depth, rows });
    return rows;
  }

  private async buildRanked(token: string, info: SupplyInfo, depth: number): Promise<HolderRow[]> {
    const rows = await this.db
      .select({ holder: tokenHolders.holder, balance: tokenHolders.balance })
      .from(tokenHolders)
      .where(and(eq(tokenHolders.token, token), sql`${tokenHolders.balance} > 0`))
      .orderBy(desc(tokenHolders.balance))
      .limit(depth);
    if (rows.length === 0) return [];

    const addresses = rows.map((r) => r.holder);
    const [labels, live] = await Promise.all([
      this.labels.label(addresses, token),
      this.balancesOf(token, addresses),
    ]);

    return rows
      .map((r) => {
        // The chain's answer where we got one; the index's only if the
        // multicall itself failed.
        const raw = live.get(r.holder) ?? BigInt(r.balance.split('.')[0]);
        const l = labels.get(r.holder) ?? { label: 'contract' as const, name: null };
        return {
          rank: 0,
          address: getAddress(r.holder),
          label: l.label,
          labelName: l.name,
          raw,
          balance: formatUnits(raw, info.decimals),
          percent: pct(raw, info.totalSupply),
        };
      })
      .filter((h) => h.raw > 0n)
      .sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0))
      .map(({ raw: _raw, ...h }, i) => ({ ...h, rank: i + 1 }));
  }

  private async balancesOf(token: string, holders: string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    try {
      const results = await this.chain.client.multicall({
        multicallAddress: this.chain.network.multicall3,
        allowFailure: true,
        contracts: holders.map(
          (h) =>
            ({
              address: getAddress(token) as Address,
              abi: TOKEN_ABI,
              functionName: 'balanceOf',
              args: [getAddress(h) as Address],
            }) as const,
        ),
      });
      holders.forEach((h, i) => {
        const r = results[i];
        if (r?.status === 'success') out.set(h, r.result as bigint);
      });
    } catch (err) {
      this.log.warn(`balance verification failed for ${token}: ${(err as Error).message.split('\n')[0]}`);
    }
    return out;
  }

  private breakdown(ranked: HolderRow[]): HolderBreakdown | null {
    if (ranked.length === 0) return null;
    const sum = (rows: HolderRow[]) =>
      rows.some((r) => r.percent == null)
        ? null
        : round(rows.reduce((s, r) => s + (r.percent ?? 0), 0));
    return {
      top10WalletsPercent: sum(ranked.filter((r) => r.label === 'wallet').slice(0, 10)),
      poolsPercent: sum(ranked.filter((r) => r.label === 'pool')),
      burnedPercent: sum(ranked.filter((r) => r.label === 'burn')),
      contractsPercent: sum(ranked.filter((r) => r.label === 'contract' || r.label === 'token')),
      basis: ranked.length,
    };
  }

  private drift(indexed: bigint, supply: bigint): HoldersBlock['drift'] {
    if (supply === 0n) return null;
    const ratio = Number((indexed * 1_000_000n) / supply) / 1_000_000;
    return Math.abs(ratio - 1) > DRIFT_TOLERANCE
      ? { indexedPercentOfSupply: round(ratio * 100) }
      : null;
  }

  /**
   * Addresses that hold several of the given tokens, among each token's
   * largest holders.
   *
   * Computed here, in code, and never by the model: intersecting ten lists
   * of fifty addresses by reading them is exactly where a language model
   * invents an overlap. Pools, burns and contracts are excluded by default —
   * otherwise the answer is the Uniswap PoolManager, every time.
   *
   * Tokens still indexing are left out of the comparison and listed with
   * their progress, rather than compared on a partial holder list that would
   * miss exactly the overlaps being looked for.
   */
  async commonHolders(
    tokens: string[],
    opts: { topN?: number; minTokens?: number; include?: HolderLabel[] } = {},
  ): Promise<{
    tokens: OverlapToken[];
    overlaps: OverlapHolder[];
    topN: number;
    minTokens: number;
    include: HolderLabel[];
  }> {
    const list = [...new Set(tokens.filter((t) => isAddress(t)).map((t) => t.toLowerCase()))].slice(
      0,
      MAX_OVERLAP_TOKENS,
    );
    const topN = Math.min(Math.max(opts.topN ?? 50, 5), MAX_TOP_N);
    const minTokens = Math.max(opts.minTokens ?? 2, 2);
    const include = opts.include?.length ? opts.include : (['wallet'] as HolderLabel[]);
    const allowed = new Set(include);

    const infos = new Map(
      await Promise.all(list.map(async (t) => [t, await this.supply(t)] as const)),
    );
    await this.index.requestMany(
      list.filter((t) => infos.get(t)),
      PRIORITY.userRequest,
    );
    const progress = await this.index.progress(list);

    const byHolder = new Map<string, OverlapHolder>();
    const summaries: OverlapToken[] = [];

    // Each token's holders are fetched in parallel, then merged in list order
    // so the result does not depend on which lookup finished first.
    const perToken = await Promise.all(
      list.map(async (token) => {
        const p: HolderIndexProgress | undefined = progress.get(token);
        const info = infos.get(token) ?? null;
        const symbol = info?.symbol || token.slice(0, 8);
        if (!p || p.status !== 'ready' || !info) {
          return {
            summary: {
              address: getAddress(token),
              symbol,
              status: (!info ? 'unavailable' : (p?.status ?? 'not_indexed')) as HoldersStatus,
              progress: p?.percent ?? 0,
              holdersCompared: 0,
            },
            ranked: [] as HolderRow[],
            token,
            symbol,
          };
        }
        // Look deeper than topN so that filtering out pools and contracts
        // still leaves topN of the requested kind.
        const ranked = (await this.rankedHolders(token, info, Math.min(topN * 3, 300)))
          .filter((h) => allowed.has(h.label))
          .slice(0, topN);
        return {
          summary: {
            address: getAddress(token),
            symbol,
            status: 'ready' as HoldersStatus,
            progress: 100,
            holdersCompared: ranked.length,
          },
          ranked,
          token,
          symbol,
        };
      }),
    );

    for (const { summary, ranked, token, symbol } of perToken) {
      summaries.push(summary);
      ranked.forEach((h, i) => {
        const key = h.address.toLowerCase();
        let entry = byHolder.get(key);
        if (!entry) byHolder.set(key, (entry = { address: h.address, tokens: [] }));
        entry.tokens.push({ address: getAddress(token), symbol, percent: h.percent, rank: i + 1 });
      });
    }

    const overlaps = [...byHolder.values()]
      .filter((h) => h.tokens.length >= minTokens)
      .sort(
        (a, b) =>
          b.tokens.length - a.tokens.length ||
          a.tokens.reduce((s, t) => s + t.rank, 0) / a.tokens.length -
            b.tokens.reduce((s, t) => s + t.rank, 0) / b.tokens.length,
      );

    return { tokens: summaries, overlaps, topN, minTokens, include };
  }

  /** What one address holds among indexed tokens, priced where the market can. */
  async walletHoldings(address: string): Promise<{
    address: string;
    label: HolderLabel;
    labelName: string | null;
    holdings: WalletHolding[];
    indexedTokens: number;
  }> {
    const who = address.toLowerCase();
    const [labelled, rows, [{ n }]] = await Promise.all([
      this.labels.label([who]),
      this.db
        .select({ token: tokenHolders.token, balance: tokenHolders.balance })
        .from(tokenHolders)
        .innerJoin(tokenIndexState, eq(tokenIndexState.token, tokenHolders.token))
        .where(
          and(
            eq(tokenHolders.holder, who),
            eq(tokenIndexState.status, 'ready'),
            sql`${tokenHolders.balance} > 0`,
          ),
        ),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(tokenIndexState)
        .where(eq(tokenIndexState.status, 'ready')),
    ]);

    const tokens = rows.map((r) => r.token);
    const [infos, live, prices] = await Promise.all([
      Promise.all(tokens.map((t) => this.supply(t))),
      this.balancesAcross(who, tokens),
      tokens.length ? this.market.volumes(tokens) : Promise.resolve([]),
    ]);
    const priceOf = new Map(prices.map((p) => [p.address.toLowerCase(), p.priceUsd]));

    const holdings: WalletHolding[] = [];
    tokens.forEach((t, i) => {
      const info = infos[i];
      if (!info) return;
      const raw = live.get(t) ?? BigInt(rows[i].balance.split('.')[0]);
      if (raw <= 0n) return;
      const amount = formatUnits(raw, info.decimals);
      const price = priceOf.get(t) ?? null;
      holdings.push({
        token: getAddress(t),
        symbol: info.symbol,
        name: info.name,
        balance: amount,
        percent: pct(raw, info.totalSupply),
        priceUsd: price,
        valueUsd: price != null ? round(Number(amount) * price) : null,
      });
    });
    holdings.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

    const l = labelled.get(who) ?? { label: 'contract' as const, name: null };
    return {
      address: getAddress(who),
      label: l.label,
      labelName: l.name,
      holdings,
      indexedTokens: n,
    };
  }

  /** One address's balance across several tokens, in one multicall. */
  private async balancesAcross(holder: string, tokens: string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    if (tokens.length === 0) return out;
    try {
      const results = await this.chain.client.multicall({
        multicallAddress: this.chain.network.multicall3,
        allowFailure: true,
        contracts: tokens.map(
          (t) =>
            ({
              address: getAddress(t) as Address,
              abi: TOKEN_ABI,
              functionName: 'balanceOf',
              args: [getAddress(holder) as Address],
            }) as const,
        ),
      });
      tokens.forEach((t, i) => {
        if (results[i]?.status === 'success') out.set(t, results[i].result as bigint);
      });
    } catch {
      /* fall back to indexed balances */
    }
    return out;
  }

  /** Progress for tokens, without queuing anything. For polling. */
  async status(tokens: string[]): Promise<Array<{ address: string; status: HoldersStatus; progress: number }>> {
    const list = [...new Set(tokens.filter((t) => isAddress(t)).map((t) => t.toLowerCase()))].slice(0, MAX_OVERLAP_TOKENS);
    const progress = await this.index.progress(list);
    return list.map((t) => {
      const p = progress.get(t);
      return {
        address: getAddress(t),
        status: p?.status ?? 'not_indexed',
        progress: p?.percent ?? 0,
      };
    });
  }
}

function pct(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null;
  return Number((part * 10_000_000n) / whole) / 100_000;
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
