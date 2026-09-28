import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseUnits, formatUnits } from 'viem';
import { PendingIntentStore, type PendingIntent } from './pending-intent.store';
import { QuoteService } from './quote.service';
import { SwapService } from './swap.service';
import { TokensService } from './tokens.service';
import { UserWalletService } from '../accounts/user-wallet.service';
import { TradeLedgerService } from '../accounts/trade-ledger.service';
import { NATIVE_TOKEN, explorerTxUrl, type BaseToken } from '../chain/networks';
import { ChainService } from '../chain/chain.service';
import { PoolIndexService, type PoolRecord } from '../chain/pool-index.service';
import type { TradeIntent } from '../openserv/schemas';
import { MarketService } from '../market/market.service';
import { SandboxService } from '../sandbox/sandbox.service';
import { TransferTaxService, type TransferTax } from '../chain/transfer-tax.service';
import { InsufficientPaperFunds, toFloat } from '../sandbox/paper-ledger';
import type { TokenLink, TokenMarket, TokenPool, TokenStats } from '../market/market.types';
import { PortfolioService } from '../accounts/portfolio.service';

/** What the orchestrator hands back to the chat on every turn. */
export type TradeStep =
  | { kind: 'need_token'; intentId: string; ticker?: string; message: string }
  | {
      kind: 'choose_token';
      intentId: string;
      message: string;
      candidates: PendingIntent['candidates'];
    }
  | {
      /**
       * The token page: everything needed to decide, including which venue.
       * Replaces `need_amount`, which carried only a symbol — not enough to
       * judge whether a contract is worth money.
       */
      kind: 'token_detail';
      intentId: string;
      token: {
        address: string;
        symbol: string;
        name: string;
        decimals: number;
        imageUrl: string | null;
        websites: TokenLink[];
        socials: TokenLink[];
      };
      stats: TokenStats | null;
      pools: TokenPool[];
      /** Set once a venue is chosen, so the card can show it selected. */
      selectedPoolId?: string;
      /** Buying or selling: decides what the amount box is denominated in. */
      action: 'buy' | 'sell';
      /** Once a venue is chosen: what is held of the asset being spent. */
      available?: { amount: string; symbol: string } | null;
      /** True when Dexscreener knew nothing and this is chain data only. */
      degraded: boolean;
      message: string;
    }
  | {
      kind: 'confirm';
      intentId: string;
      quoteId: string;
      message: string;
      summary: Record<string, string>;
      mode: 'sandbox' | 'live';
    }
  | {
      kind: 'executed';
      intentId: string;
      /** Live trades only: paper fills have no transaction. */
      txHash?: string;
      explorerUrl?: string;
      message: string;
      mode: 'sandbox' | 'live';
      paper?: PaperFillSummary;
    }
  | { kind: 'rejected'; message: string };

export interface PaperFillSummary {
  spent: string;
  received: string;
  valueUsd: number;
  feeUsd: number;
  /** Which paper balance paid the simulated network fee. */
  feeAsset: string;
  /** Profit locked in, on sells. */
  realizedUsd: number | null;
}

/**
 * A token amount people can read: at most eight significant digits, cut
 * rather than rounded, so a guaranteed minimum is never shown higher than it
 * is. 119.06273097542… becomes 119.06273.
 */
/** Uniswap v4's marker for a pool whose fee is set by its hook, not fixed. */
const DYNAMIC_FEE_FLAG = 0x800000;

/**
 * The pool fee in words a person can trust. A dynamic-fee pool stores the
 * flag 0x800000 where a fixed pool stores its fee, and dividing the flag as if
 * it were a fee showed "838.8608%". Its stored fee is often 0 as well, because
 * the hook sets the real one per trade — so no number is shown for those. The
 * quote already includes whatever the hook charges.
 */
export function poolFeeText(feeTier: number): string {
  if ((feeTier & DYNAMIC_FEE_FLAG) !== 0) {
    return 'Set by the pool for each trade — already included in the price above';
  }
  return `${feeTier / 10_000}%`;
}

/**
 * "Sell all" means all. Amounts arrive as JavaScript numbers, which keep
 * about 15 significant digits; an 18-decimal balance has more, so selling the
 * whole of 8405.595584783470486026 sold 8405.59558478347 and left a speck
 * behind that showed as a $0 position. Within a millionth of the balance, in
 * either direction, the whole balance is sold.
 */
export function wholeIfAll(amount: bigint, held: bigint): bigint {
  if (held <= 0n) return amount;
  const diff = amount > held ? amount - held : held - amount;
  return diff * 1_000_000n <= held ? held : amount;
}

/** A share of a balance, exactly: 100% is the whole balance, never a rounded float. */
export function percentOf(held: bigint, percent: number): bigint {
  if (percent >= 100) return held;
  return (held * BigInt(Math.round(percent * 100))) / 10_000n;
}

/** An amount after a percentage is taken off it, in base units. */
export function afterTax(units: bigint, pct: number): bigint {
  if (!pct || pct <= 0) return units;
  const keep = BigInt(Math.round((100 - Math.min(pct, 100)) * 10_000));
  return (units * keep) / 1_000_000n;
}

export function readable(units: bigint, decimals: number, significant = 8): string {
  const full = formatUnits(units, decimals);
  const [whole, frac = ''] = full.split('.');
  if (!frac) return whole;
  const lead = whole.replace(/^0+/, '').length;
  if (lead >= significant) return whole;
  if (lead > 0) {
    const keep = frac.slice(0, significant - lead).replace(/0+$/, '');
    return keep ? `${whole}.${keep}` : whole;
  }
  // Below one: keep the leading zeros, then the significant digits.
  const zeros = frac.match(/^0*/)![0].length;
  const keep = frac.slice(0, zeros + significant).replace(/0+$/, '');
  return keep ? `0.${keep}` : '0';
}

/** Gas for a single-pool v4 swap through the Universal Router, measured on-chain as ~150–180k. */
const PAPER_SWAP_GAS = 180_000n;

/**
 * Drives a trade from loose chat intent to a signed swap.
 *
 * Every turn re-reads state from the store rather than trusting anything the
 * client sent, and the ladder is strictly need_token -> need_amount ->
 * confirm -> execute. Nothing reaches the wallet without a human confirming a
 * specific quote id.
 */
@Injectable()
export class TradingService {
  private readonly log = new Logger(TradingService.name);

  constructor(
    private readonly store: PendingIntentStore,
    private readonly quotes: QuoteService,
    private readonly swaps: SwapService,
    private readonly tokens: TokensService,
    private readonly wallet: UserWalletService,
    private readonly config: ConfigService,
    private readonly chain: ChainService,
    private readonly index: PoolIndexService,
    private readonly market: MarketService,
    private readonly ledger: TradeLedgerService,
    private readonly sandbox: SandboxService,
    private readonly taxes: TransferTaxService,
    private readonly portfolio: PortfolioService,
  ) {}

  /** Entry point for a fresh trade intent extracted by the OpenServ runtime. */
  async begin(sessionId: string, intent: TradeIntent): Promise<TradeStep> {
    // Read once, here, and fixed on the trade for its whole life.
    const mode = await this.sandbox.mode(sessionId);
    const pending = this.store.create(sessionId, intent, mode);

    if (intent.contractAddress) {
      let token;
      try {
        token = await this.tokens.describe(intent.contractAddress);
      } catch (err) {
        return { kind: 'rejected', message: (err as Error).message };
      }
      if (!token) {
        return {
          kind: 'rejected',
          message: `${intent.contractAddress} does not look like a token on Robinhood Chain.`,
        };
      }
      this.store.patch(pending.id, sessionId, { token });
    } else if (intent.action === 'sell' && intent.ticker) {
      const holding =
        mode === 'sandbox'
          ? await this.sandbox.findHeldToken(sessionId, intent.ticker)
          : await this.portfolio.findHeldToken(sessionId, intent.ticker);
      if (!holding) {
        return {
          kind: 'rejected',
          message: `I could not find ${intent.ticker} in your portfolio. Tell me the exact token symbol or contract address you want to sell.`,
        };
      }
      const token = await this.tokens.describe(holding.address);
      if (!token) {
        return {
          kind: 'rejected',
          message: `I found ${holding.symbol} in your portfolio, but I could not read its token details safely.`,
        };
      }
      this.store.patch(pending.id, sessionId, { token });
    }
    return this.advance(sessionId, pending.id);
  }

  /** Recomputes the next step from stored state. Safe to call repeatedly. */
  async advance(sessionId: string, intentId: string): Promise<TradeStep> {
    const intent = this.store.get(intentId, sessionId);

    if (!intent.token) {
      const candidates = intent.ticker
        ? await this.tokens.findByTicker(intent.ticker)
        : [];
      if (candidates.length === 0) {
        return {
          kind: 'need_token',
          intentId: intent.id,
          ticker: intent.ticker,
          message: intent.ticker
            ? `I could not pin down which "${intent.ticker}" you mean. Paste the contract address and I will take it from there.`
            : 'Which token? Paste its contract address.',
        };
      }
      this.store.patch(intent.id, sessionId, { candidates });
      return {
        kind: 'choose_token',
        intentId: intent.id,
        message: `I found ${candidates.length} tokens matching "${intent.ticker}". Which one?`,
        candidates,
      };
    }

    // A venue must be chosen before a price means anything, and the amount is
    // meaningless without knowing what it buys. Both gates land on the token
    // page rather than a bare prompt.
    if (!intent.pool || (!intent.amount && intent.percent == null)) {
      return this.tokenPage(sessionId, intent.id);
    }

    return this.priceIt(sessionId, intent.id);
  }

  /**
   * Builds the token page: identity, market stats, and the tradeable venues.
   *
   * Market data is fetched once per intent and cached on it. The page is
   * re-rendered on every step of the pick-a-pool dance, and re-querying an
   * upstream on each of those would be both slow and rude.
   */
  private async tokenPage(
    sessionId: string,
    intentId: string,
  ): Promise<TradeStep> {
    const intent = this.store.get(intentId, sessionId);
    const token = intent.token!;

    let market: TokenMarket | null = intent.market ?? null;
    if (!market) {
      market = await this.market.forToken(token.address);
      if (market) this.store.patch(intentId, sessionId, { market });
    }

    const pools = market?.pools ?? [];
    if (pools.length === 0) {
      return {
        kind: 'rejected',
        message: `I cannot find a Uniswap v4 pool for ${token.symbol} on this chain, so there is nothing to trade against.`,
      };
    }

    const chosen = intent.pool?.id;
    // With a venue chosen, say what there is to spend — the token on a sell,
    // the pool's other side on a buy — so a percentage has a visible base.
    let available: { amount: string; symbol: string } | null = null;
    if (intent.pool) {
      const picked = await this.fundingForPool(intent.pool, token.address);
      if (!('error' in picked)) {
        const spend = intent.action === 'buy' ? picked.token : { address: token.address, symbol: token.symbol, decimals: token.decimals };
        const paper = intent.mode === 'sandbox';
        const { held } = await this.spendable(sessionId, paper, spend.address).catch(() => ({ held: null as bigint | null }));
        if (held != null) {
          available = {
            amount: readable(held, spend.decimals),
            symbol: paper ? this.paperSymbol(spend) : spend.symbol,
          };
        }
      }
    }
    const message = chosen
      ? `How much do you want to ${intent.action}?`
      : pools.length === 1
        ? `${token.symbol} trades against ${pools[0].quoteSymbol}. Pick it to continue.`
        : `${token.symbol} trades on ${pools.length} venues. Which one?`;

    return {
      kind: 'token_detail',
      intentId,
      token: {
        address: token.address,
        symbol: market?.symbol || token.symbol,
        name: market?.name || token.name,
        decimals: token.decimals,
        imageUrl: market?.imageUrl ?? null,
        websites: market?.websites ?? [],
        socials: market?.socials ?? [],
      },
      stats: market?.stats ?? null,
      pools,
      selectedPoolId: chosen,
      action: intent.action,
      available,
      degraded: market?.degraded ?? true,
      message,
    };
  }

  async selectToken(
    sessionId: string,
    intentId: string,
    candidateId: string,
  ): Promise<TradeStep> {
    this.store.selectCandidate(intentId, sessionId, candidateId);
    return this.advance(sessionId, intentId);
  }

  /**
   * Pins the venue for this trade.
   *
   * `resolveForToken` both recovers the PoolKey and proves the pool actually
   * trades this token — the poolId arrives from the browser having originated
   * at a third-party API, and an opaque id pointing at the wrong pair would
   * look like nothing until the funds moved.
   */
  async selectPool(
    sessionId: string,
    intentId: string,
    poolId: string,
  ): Promise<TradeStep> {
    const intent = this.store.get(intentId, sessionId);
    const token = intent.token;
    if (!token) {
      return { kind: 'rejected', message: 'Pick a token first.' };
    }

    // Only offer what the page offered; an id from nowhere is not a venue.
    const listed = intent.market?.pools.some((p) => p.poolId === poolId);
    if (!listed) {
      return { kind: 'rejected', message: 'That is not one of the listed pools.' };
    }

    let pool;
    try {
      pool = await this.index.resolveForToken(poolId, token.address);
    } catch (err) {
      return { kind: 'rejected', message: (err as Error).message };
    }

    this.store.patch(intentId, sessionId, { pool });
    return this.advance(sessionId, intentId);
  }

  async setAmount(
    sessionId: string,
    intentId: string,
    amount: number,
  ): Promise<TradeStep> {
    if (!Number.isFinite(amount) || amount <= 0) {
      return { kind: 'rejected', message: 'That amount is not a positive number.' };
    }
    this.store.patch(intentId, sessionId, { amount, percent: undefined });
    return this.advance(sessionId, intentId);
  }

  /**
   * Sizes the trade as a share of what is held — "sell 100%", "half my
   * USDG". Worked out here from the exact balance, not by the model: a model
   * converting "100%" into a number of tokens has to look the balance up, do
   * the arithmetic, and then pass a float that cannot hold an 18-decimal
   * balance, which left a speck behind on every "sell all".
   */
  async setPercent(sessionId: string, intentId: string, percent: number): Promise<TradeStep> {
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      return { kind: 'rejected', message: 'Give a percentage between 1 and 100.' };
    }
    this.store.patch(intentId, sessionId, { percent, amount: undefined });
    return this.advance(sessionId, intentId);
  }

  /** What is held of the asset a trade spends: paper balance, or the real wallet. */
  private async spendable(
    sessionId: string,
    paper: boolean,
    asset: string,
  ): Promise<{ held: bigint; owner: string | null }> {
    if (paper) return { held: await this.sandbox.balanceOf(sessionId, asset), owner: null };
    const owner = await this.wallet.addressOf(sessionId);
    const held =
      asset === NATIVE_TOKEN
        ? await this.chain.client.getBalance({ address: owner })
        : await this.tokens.balanceOf(asset as `0x${string}`, owner);
    return { held, owner };
  }

  /** ETH to leave for the network fee: twice a swap's gas, with a floor if gas cannot be read. */
  private async feeReserve(): Promise<bigint> {
    const gasPrice = await this.chain.client.getGasPrice().catch(() => null);
    return gasPrice != null ? PAPER_SWAP_GAS * gasPrice * 2n : 10n ** 14n;
  }

  /** Quote + spend-cap check. The gate the original plan skipped entirely. */
  private async priceIt(sessionId: string, intentId: string): Promise<TradeStep> {
    const intent = this.store.get(intentId, sessionId);
    const token = intent.token!;
    // A buy spends the funding asset; a sell spends the token and receives it.
    const buying = intent.action === 'buy';
    const paper = intent.mode === 'sandbox';

    // The venue decides the funding asset: the other side of the chosen pool
    // is what a buy spends, by definition. Re-deriving it from preferences
    // could name an asset this pool does not even trade.
    const pool = intent.pool!;
    const picked = await this.fundingForPool(pool, token.address);
    if ('error' in picked) return { kind: 'rejected', message: picked.error };
    const funding = picked.token;

    const tokenIn = buying ? funding.address : token.address;
    const tokenOut = buying ? token.address : funding.address;
    const decimalsIn = buying ? funding.decimals : token.decimals;
    const spending = buying ? funding : token;
    const spendingSymbol = paper ? this.paperSymbol(spending) : spending.symbol;

    // What is held of the asset being spent — native ETH included, which the
    // single-wallet version skipped. Read before sizing the trade, so a
    // percentage is taken of the exact balance rather than of a rounded number.
    const { held, owner } = await this.spendable(sessionId, paper, tokenIn);

    let amountIn: bigint;
    let reservedForFee = false;
    if (intent.percent != null) {
      if (held === 0n) {
        return {
          kind: 'rejected',
          message: `You have no ${spendingSymbol} to ${buying ? 'spend' : 'sell'}${paper ? ' in your sandbox' : ''}.`,
        };
      }
      amountIn = percentOf(held, intent.percent);
      // All of your ETH leaves nothing for the network fee, and the trade
      // fails. Keep a small reserve back when the percentage would eat it.
      if (tokenIn === NATIVE_TOKEN) {
        const reserve = await this.feeReserve();
        if (held - amountIn < reserve) {
          amountIn = held > reserve ? held - reserve : 0n;
          reservedForFee = true;
        }
      }
      if (amountIn <= 0n) {
        return {
          kind: 'rejected',
          message: `That is too little ${spendingSymbol} to trade once the network fee is set aside.`,
        };
      }
    } else {
      amountIn = parseUnits(intent.amount!.toString(), decimalsIn);
      if (!buying) amountIn = wholeIfAll(amountIn, held);
    }

    // The cap is denominated in USD, so the amount has to be converted into it
    // before comparing. Testing `amount > cap` directly was wrong the moment
    // funding stopped always being a dollar stablecoin: "10" of a token worth
    // $2,700 is $27,000, and a raw compare waves it straight past a $25 cap.
    // The cap protects real money. Paper trades still meet real price impact,
    // which is the lesson a cap would hide.
    if (buying && !paper) {
      const cap = this.config.getOrThrow<number>('MAX_TRADE_USD');
      const usd = await this.notionalUsd(funding, amountIn);
      if (usd === null) {
        return {
          kind: 'rejected',
          message:
            `I cannot price ${funding.symbol} in dollars right now, so I ` +
            'cannot check it against the spend cap. Refusing rather than ' +
            'guessing.',
        };
      }
      if (usd > cap) {
        return {
          kind: 'rejected',
          message:
            `That is about $${usd.toFixed(2)}, above the $${cap} per-trade ` +
            `cap this agent runs under.`,
        };
      }
    }

    // Finding out after signing wastes gas and hands the user a failed
    // transaction, so the balance is checked here.
    if (held < amountIn) {
      return {
        kind: 'rejected',
        message: paper
          ? `Your sandbox holds ${readable(held, spending.decimals)} ${spendingSymbol}, ` +
            'not enough for this trade. Add paper funds from the sandbox bar, or ask me to add some.'
          : `Your wallet holds ${readable(held, spending.decimals)} ${spending.symbol}, ` +
            `not enough for this trade. Deposit to ${owner} to top up.`,
      };
    }

    let quote;
    try {
      quote = await this.quotes.quoteExactIn({
        tokenIn,
        tokenOut,
        amountIn,
        maxSlippageBps: this.config.getOrThrow<number>('MAX_SLIPPAGE_BPS'),
        pool,
      });
    } catch (err) {
      return { kind: 'rejected', message: (err as Error).message };
    }

    // The token's own transfer tax, which the pool quote cannot see. Measured
    // on the amount that will actually move: what a buy receives, or what a
    // sell sends.
    const transferTax = await this.taxes.measure(token.address, buying ? quote.amountOut : amountIn);
    this.store.patch(intentId, sessionId, { quote, funding, transferTax, status: 'quoted' });

    const decimalsOut = buying ? token.decimals : funding.decimals;
    const outSymbol = buying ? token.symbol : paper ? this.paperSymbol(funding) : funding.symbol;
    const taxPct = transferTax ? (buying ? transferTax.buyPct : transferTax.sellPct) : 0;
    const extra: Record<string, string> = {};
    if (!transferTax) {
      extra.transferTax = 'Could not be checked for this token.';
    } else if (transferTax.buyPct > 0 || transferTax.sellPct > 0) {
      extra.transferTax =
        `This token takes ${transferTax.buyPct}% on buys and ${transferTax.sellPct}% on sells. ` +
        (buying
          ? 'The amounts above are after that tax.'
          : 'You receive about that much less; on some pools a taxed sale fails outright.');
    }
    if (paper) {
      extra.networkFee = await this.paperFeeLine(sessionId, tokenIn, amountIn);
      if (funding.address !== NATIVE_TOKEN && this.paperSymbol(funding) === 'ETH') {
        extra.paperNote = 'Uses your paper ETH — in the sandbox, ETH and WETH are one balance.';
      }
    }
    return {
      kind: 'confirm',
      intentId,
      quoteId: quote.id,
      mode: intent.mode,
      message: paper
        ? 'Here is the fill at the current mainnet price. Confirm to place this paper trade — no real funds move.'
        : 'Here is the fill. Confirm and I will sign it.',
      summary: {
        action: intent.action,
        token: `${token.symbol} (${token.name})`,
        contract: token.address,
        spend:
          `${readable(amountIn, decimalsIn)} ${spendingSymbol}` +
          (intent.percent != null ? ` (${intent.percent}% of what you hold)` : '') +
          (reservedForFee ? ' — a little ETH kept back for the network fee' : ''),
        receive: `~${readable(afterTax(quote.amountOut, taxPct), decimalsOut)} ${outSymbol}`,
        guaranteedMinimum: `${readable(afterTax(quote.minAmountOut, taxPct), decimalsOut)} ${outSymbol}`,
        poolFee: poolFeeText(quote.feeTier),
        venue: `${token.symbol}/${funding.symbol}`,
        ...extra,
      },
    };
  }

  /**
   * What the paper network fee will be and which balance pays it, for the
   * confirm card — the same rule paperFill applies, so the card never
   * promises one thing and the fill does another.
   */
  private async paperFeeLine(userId: string, tokenIn: string, amountIn: bigint): Promise<string> {
    const [gasPrice, ethPrice, positions] = await Promise.all([
      this.chain.client.getGasPrice().catch(() => null),
      this.sandbox.priceUsd(NATIVE_TOKEN),
      this.sandbox.positions(userId),
    ]);
    if (gasPrice == null || ethPrice == null) return 'A small simulated fee, charged when the trade fills.';
    const feeWei = PAPER_SWAP_GAS * gasPrice;
    const feeUsd = toFloat(feeWei, 18) * ethPrice;
    const ethKey = this.sandbox.key(NATIVE_TOKEN);
    const needed = feeWei + (this.sandbox.key(tokenIn) === ethKey ? amountIn : 0n);
    const fromEth = (positions.get(ethKey)?.amount ?? 0n) >= needed;
    const amount = feeUsd < 0.01 ? `under $0.01 (about $${feeUsd.toPrecision(2)})` : `about $${feeUsd.toFixed(2)}`;
    return fromEth
      ? `${amount}, paid in paper ETH (simulated)`
      : `${amount}, paid from paper USDG — you have no spare ETH (on mainnet you would need some)`;
  }

  /**
   * Signs and broadcasts. `claimForExecution` makes this idempotent: a repeated
   * confirm returns the in-flight result rather than swapping twice, which is a
   * live hazard here — AgentKit's own sendTransaction omits the CDP idempotency
   * key, so a retry after a lost response would otherwise double-spend.
   */
  async confirm(
    sessionId: string,
    intentId: string,
    quoteId: string,
  ): Promise<TradeStep> {
    let claimed: boolean;
    try {
      claimed = this.store.claimForExecution(intentId, sessionId, quoteId);
    } catch (err) {
      return { kind: 'rejected', message: (err as Error).message };
    }

    if (!claimed) {
      const intent = this.store.get(intentId, sessionId);
      if (intent.status === 'executed' && intent.mode === 'sandbox') {
        return { kind: 'executed', intentId, mode: 'sandbox', message: 'That paper trade already filled.' };
      }
      if (intent.status === 'executed' && intent.txHash) {
        return {
          kind: 'executed',
          intentId,
          mode: 'live',
          txHash: intent.txHash,
          explorerUrl: explorerTxUrl(this.chain.explorer, intent.txHash),
          message: 'That trade already went through.',
        };
      }
      return { kind: 'rejected', message: 'That trade is already in flight.' };
    }

    const intent = this.store.get(intentId, sessionId);

    // The trade runs in the mode it was priced in, and only if the user is
    // still in that mode. Unreadable counts as changed: fail closed.
    const current = await this.sandbox.mode(sessionId).catch(() => null);
    if (current !== intent.mode) {
      this.store.patch(intentId, sessionId, { status: 'failed', error: 'mode changed' });
      return {
        kind: 'rejected',
        message:
          current == null
            ? 'I could not confirm which mode you are in, so nothing was traded. Try again in a moment.'
            : `You switched to ${current === 'sandbox' ? 'Sandbox' : 'Live'} since this quote, so it was not placed. ` +
              'Start the trade again and it will run in the mode you are in now.',
      };
    }
    if (intent.mode === 'sandbox') return this.paperFill(sessionId, intentId);

    const token = intent.token!;
    const buying = intent.action === 'buy';
    let tradeId: string | null = null;

    try {
      // Read back what was quoted rather than re-deriving it.
      const funding = intent.funding;
      if (!funding) {
        return { kind: 'rejected', message: 'That quote is incomplete. Start again.' };
      }
      // Recorded before broadcast, so a crash mid-swap leaves a pending row
      // rather than no trace of a transaction that went out.
      tradeId = await this.ledger.open({
        userId: sessionId,
        side: intent.action,
        tokenAddress: token.address,
        tokenSymbol: token.symbol,
        poolId: intent.pool?.id ?? intent.quote!.poolId,
        fundingSymbol: funding.symbol,
        amountIn: intent.quote!.amountIn,
      });

      // Signs with the requesting user's own wallet. The key is decrypted
      // inside this callback and unreachable once it returns.
      const hash = await this.wallet.withSigner(sessionId, (client, address) =>
        this.swaps.execute(
          {
            tokenIn: buying ? funding.address : token.address,
            tokenOut: buying ? token.address : funding.address,
            quote: intent.quote!,
          },
          { client, address },
        ),
      );

      const receipt = await this.swaps.waitForReceipt(hash);
      if (receipt.status !== 'success') {
        await this.ledger.settle(tradeId, { status: 'failed', error: 'reverted', txHash: hash });
        this.store.patch(intentId, sessionId, {
          status: 'failed',
          txHash: hash,
          error: 'reverted',
        });
        return {
          kind: 'rejected',
          message: `The swap reverted on-chain. ${explorerTxUrl(this.chain.explorer, hash)}`,
        };
      }

      await this.ledger.settle(tradeId, {
        status: 'confirmed',
        txHash: hash,
        amountOut: intent.quote!.amountOut,
      });
      this.store.patch(intentId, sessionId, { status: 'executed', txHash: hash });
      return {
        kind: 'executed',
        intentId,
        mode: 'live',
        txHash: hash,
        explorerUrl: explorerTxUrl(this.chain.explorer, hash),
        message: `Done — ${intent.action} ${token.symbol} filled.`,
      };
    } catch (err) {
      const message = (err as Error).message;
      // Settle the ledger row, or it sits at `pending` forever — claiming a
      // transaction might be in flight when signing never even happened.
      if (tradeId) {
        await this.ledger
          .settle(tradeId, { status: 'failed', error: message })
          .catch(() => undefined);
      }
      this.store.patch(intentId, sessionId, { status: 'failed', error: message });
      this.log.error(`swap failed for intent ${intentId}: ${message}`);
      return { kind: 'rejected', message: `The swap could not be completed: ${message}` };
    }
  }

  /**
   * Fills a sandbox trade on paper. Never signs, never touches the wallet.
   *
   * The price is re-quoted now, on the same pool, through the same on-chain
   * quoter, because the paper fill should be what a real swap would get at
   * this moment. If the fresh quote has fallen below the minimum the user
   * agreed to, the trade is refused — the same outcome the swap's on-chain
   * minimum would enforce. A simulated network fee is charged in paper ETH,
   * or USDG when there is no ETH, and booked as a cost.
   */
  private async paperFill(sessionId: string, intentId: string): Promise<TradeStep> {
    const intent = this.store.get(intentId, sessionId);
    const token = intent.token!;
    const funding = intent.funding;
    const quote = intent.quote;
    if (!funding || !quote || !intent.pool) {
      this.store.patch(intentId, sessionId, { status: 'failed', error: 'incomplete' });
      return { kind: 'rejected', message: 'That quote is incomplete. Start again.' };
    }
    const buying = intent.action === 'buy';
    const tokenIn = buying ? funding.address : token.address;
    const tokenOut = buying ? token.address : funding.address;
    const fail = (message: string): TradeStep => {
      this.store.patch(intentId, sessionId, { status: 'failed', error: message });
      return { kind: 'rejected', message };
    };

    let fresh;
    try {
      fresh = await this.quotes.quoteExactIn({
        tokenIn,
        tokenOut,
        amountIn: quote.amountIn,
        maxSlippageBps: this.config.getOrThrow<number>('MAX_SLIPPAGE_BPS'),
        pool: intent.pool,
      });
    } catch (err) {
      return fail(`I could not price the trade just now, so nothing was traded: ${(err as Error).message}`);
    }

    const outDecimals = buying ? token.decimals : funding.decimals;
    const outSymbol = buying ? token.symbol : this.paperSymbol(funding);
    if (fresh.amountOut < quote.minAmountOut) {
      return fail(
        `The price moved past your slippage limit since the quote — you would now get ` +
          `${readable(fresh.amountOut, outDecimals)} ${outSymbol}, below the ` +
          `${readable(quote.minAmountOut, outDecimals)} minimum. Nothing was traded; on mainnet this ` +
          'swap would have failed too. Get a fresh quote to try again.',
      );
    }

    // The token's own tax comes off what actually arrives, after the pool's
    // minimum has been checked — the same order a real swap meets them in.
    const tax = intent.transferTax ?? null;
    const received = afterTax(fresh.amountOut, tax ? (buying ? tax.buyPct : tax.sellPct) : 0);

    // The trade's dollar value, from the funding side; the token's price if
    // funding cannot be priced. Profit needs a value, so no value, no trade.
    const fundingUnits = buying ? quote.amountIn : received;
    const tokenUnits = buying ? received : quote.amountIn;
    const [fundingPrice, tokenPrice, ethPrice, gasPrice] = await Promise.all([
      this.sandbox.priceUsd(funding.address),
      this.sandbox.priceUsd(token.address),
      this.sandbox.priceUsd(NATIVE_TOKEN),
      this.chain.client.getGasPrice().catch(() => null),
    ]);
    const valueUsd =
      fundingPrice != null
        ? toFloat(fundingUnits, funding.decimals) * fundingPrice
        : tokenPrice != null
          ? toFloat(tokenUnits, token.decimals) * tokenPrice
          : null;
    if (valueUsd == null) {
      return fail(`I cannot value this trade in dollars right now, so nothing was traded. Try again shortly.`);
    }

    // Simulated network fee. ETH pays it when the sandbox holds enough;
    // otherwise USDG does, at the same dollar value.
    const ethKey = this.sandbox.key(NATIVE_TOKEN);
    const feeWei = gasPrice != null ? PAPER_SWAP_GAS * gasPrice : 0n;
    const feeUsd = ethPrice != null ? toFloat(feeWei, 18) * ethPrice : 0;
    const spendKey = this.sandbox.key(tokenIn);
    const positions = await this.sandbox.positions(sessionId);
    const ethHeld = positions.get(ethKey)?.amount ?? 0n;
    const ethNeeded = feeWei + (spendKey === ethKey ? quote.amountIn : 0n);
    const usdg = this.chain.network.baseTokens.USDG;
    let fee: Parameters<SandboxService['fill']>[1]['fee'] = null;
    if (feeWei > 0n && feeUsd > 0) {
      if (ethHeld >= ethNeeded || !usdg) {
        fee = { asset: ethKey, symbol: 'ETH', decimals: 18, units: feeWei, usd: feeUsd };
      } else {
        // Rounded up to a whole base unit: never free.
        const units = BigInt(Math.max(1, Math.ceil(feeUsd * 10 ** usdg.decimals)));
        fee = { asset: this.sandbox.key(usdg.address), symbol: 'USDG', decimals: usdg.decimals, units, usd: feeUsd };
      }
    }

    const tokenMeta = { asset: this.sandbox.key(token.address), symbol: token.symbol, decimals: token.decimals };
    const fundingMeta = {
      asset: this.sandbox.key(funding.address),
      symbol: this.paperSymbol(funding),
      decimals: funding.decimals,
    };

    let record;
    try {
      record = await this.sandbox.fill(
        sessionId,
        {
          side: intent.action,
          token: tokenMeta,
          funding: fundingMeta,
          amountIn: quote.amountIn,
          amountOut: received,
          valueUsd,
          fee,
        },
        {
          tokenAddress: token.address,
          tokenSymbol: token.symbol,
          poolId: intent.pool.id,
          fundingAddress: funding.address,
          fundingSymbol: fundingMeta.symbol,
        },
      );
    } catch (err) {
      if (err instanceof InsufficientPaperFunds) {
        return fail(
          `Your sandbox holds ${formatUnits(err.held, err.decimals)} ${err.symbol}, but this needs ` +
            `${formatUnits(err.needed, err.decimals)} ${err.symbol} (including the network fee). Nothing was traded.`,
        );
      }
      this.log.error(`paper fill failed for intent ${intentId}: ${(err as Error).message}`);
      return fail('The paper trade could not be recorded, so nothing changed. Try again.');
    }

    this.store.patch(intentId, sessionId, { status: 'executed' });
    const spentSymbol = buying ? fundingMeta.symbol : token.symbol;
    const spentDecimals = buying ? funding.decimals : token.decimals;
    const receivedText = `${readable(received, outDecimals)} ${outSymbol}`;
    const taxed = tax && (buying ? tax.buyPct : tax.sellPct) > 0;
    return {
      kind: 'executed',
      intentId,
      mode: 'sandbox',
      message:
        `Paper trade filled — ${intent.action === 'buy' ? 'bought' : 'sold'} ${token.symbol}, received ${receivedText}` +
        (taxed ? ` after the token's ${buying ? tax!.buyPct : tax!.sellPct}% transfer tax.` : '.'),
      paper: {
        spent: `${readable(quote.amountIn, spentDecimals)} ${spentSymbol}`,
        received: receivedText,
        valueUsd,
        feeUsd: fee?.usd ?? 0,
        feeAsset: fee?.symbol ?? 'ETH',
        realizedUsd: buying ? null : record.realizedUsd,
      },
    };
  }

  /** ETH and WETH are one paper balance, so both are called ETH in the sandbox. */
  private paperSymbol(asset: { address: string; symbol: string }): string {
    return this.sandbox.key(asset.address) === this.sandbox.key(NATIVE_TOKEN) ? 'ETH' : asset.symbol;
  }

  /**
   * The funding asset is whatever sits on the other side of the chosen pool.
   *
   * v1 picked this from the user's stated currency and a pool search, which
   * could name an asset the selected venue does not trade. Once a venue is
   * pinned there is no choice left to make: a MAKER/USDG pool spends USDG.
   *
   * Decimals come from the network's known base assets where possible and are
   * read from the contract otherwise — getting them wrong is not a rounding
   * error, since USDG has 6 and ETH has 18.
   */
  private async fundingForPool(
    pool: PoolRecord,
    token: `0x${string}`,
  ): Promise<{ token: BaseToken } | { error: string }> {
    const self = token.toLowerCase();
    const other = (
      pool.currency0.toLowerCase() === self ? pool.currency1 : pool.currency0
    ) as `0x${string}`;

    if (other.toLowerCase() === NATIVE_TOKEN.toLowerCase()) {
      return { token: { address: NATIVE_TOKEN, symbol: 'ETH', decimals: 18 } };
    }

    const known = Object.values(this.chain.network.baseTokens).find(
      (b) => b.address.toLowerCase() === other.toLowerCase(),
    );
    if (known) return { token: { ...known } };

    const described = await this.tokens.describe(other);
    if (!described) {
      return { error: 'I cannot read the other side of that pool.' };
    }
    return {
      token: {
        address: described.address,
        symbol: described.symbol,
        decimals: described.decimals,
      },
    };
  }

  /**
   * Re-prices a quote that went stale, on the same venue.
   *
   * Expiry used to be a dead end: the card disabled itself and the only way
   * forward was to start the trade over. The new quote gets a new id, which
   * retires the old one — a stale card left open in another tab must not stay
   * confirmable.
   */
  async requote(sessionId: string, intentId: string): Promise<TradeStep> {
    const intent = this.store.get(intentId, sessionId);

    if (intent.status === 'executing' || intent.status === 'executed') {
      return {
        kind: 'rejected',
        message: 'That trade has already been sent; there is nothing to re-price.',
      };
    }
    if (!intent.token || !intent.pool || !intent.amount) {
      return { kind: 'rejected', message: 'That trade is incomplete. Start again.' };
    }

    // Back to collecting so the old quote id can no longer be claimed while
    // the new price is being fetched.
    this.store.patch(intentId, sessionId, {
      status: 'collecting',
      quote: undefined,
    });
    return this.priceIt(sessionId, intentId);
  }

  /**
   * Dollar value of an amount of the funding asset, for the spend cap.
   * Returns null when it cannot be priced, so the caller can fail closed
   * instead of letting an uncapped trade through.
   */
  private async notionalUsd(
    funding: BaseToken,
    amountIn: bigint,
  ): Promise<number | null> {
    const usdg = this.chain.network.baseTokens.USDG;
    if (!usdg) return null;
    if (funding.address.toLowerCase() === usdg.address.toLowerCase()) {
      return Number(formatUnits(amountIn, funding.decimals));
    }
    try {
      const quote = await this.quotes.quoteExactIn({
        tokenIn: funding.address,
        tokenOut: usdg.address,
        amountIn,
        maxSlippageBps: 0,
      });
      return Number(formatUnits(quote.amountOut, usdg.decimals));
    } catch {
      return null;
    }
  }
}
