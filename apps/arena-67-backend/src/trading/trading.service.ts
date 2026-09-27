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
import type { TokenLink, TokenMarket, TokenPool, TokenStats } from '../market/market.types';

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
    }
  | { kind: 'executed'; intentId: string; txHash: string; explorerUrl: string; message: string }
  | { kind: 'rejected'; message: string };

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
  ) {}

  /** Entry point for a fresh trade intent extracted by the OpenServ runtime. */
  async begin(sessionId: string, intent: TradeIntent): Promise<TradeStep> {
    const pending = this.store.create(sessionId, intent);

    if (intent.contractAddress) {
      const token = await this.tokens.describe(intent.contractAddress);
      if (!token) {
        return {
          kind: 'rejected',
          message: `${intent.contractAddress} does not look like a token on Robinhood Chain.`,
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
    if (!intent.pool || !intent.amount) {
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
    this.store.patch(intentId, sessionId, { amount });
    return this.advance(sessionId, intentId);
  }

  /** Quote + spend-cap check. The gate the original plan skipped entirely. */
  private async priceIt(sessionId: string, intentId: string): Promise<TradeStep> {
    const intent = this.store.get(intentId, sessionId);
    const token = intent.token!;
    const amount = intent.amount!;

    // A buy spends the funding asset; a sell spends the token and receives it.
    const buying = intent.action === 'buy';

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
    const amountIn = parseUnits(amount.toString(), decimalsIn);

    // The cap is denominated in USD, so the amount has to be converted into it
    // before comparing. Testing `amount > cap` directly was wrong the moment
    // funding stopped always being a dollar stablecoin: "10" of a token worth
    // $2,700 is $27,000, and a raw compare waves it straight past a $25 cap.
    if (buying) {
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

    // Check the balance of whatever is actually being spent — native ETH
    // included, which the single-wallet version skipped. Finding out after
    // signing wastes gas and hands the user a failed transaction.
    {
      const owner = await this.wallet.addressOf(sessionId);
      const spending = buying ? funding : token;
      const held =
        tokenIn === NATIVE_TOKEN
          ? await this.chain.client.getBalance({ address: owner })
          : await this.tokens.balanceOf(tokenIn as `0x${string}`, owner);
      if (held < amountIn) {
        return {
          kind: 'rejected',
          message:
            `Your wallet holds ${formatUnits(held, spending.decimals)} ${spending.symbol}, ` +
            `not enough for this trade. Deposit to ${owner} to top up.`,
        };
      }
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

    this.store.patch(intentId, sessionId, { quote, funding, status: 'quoted' });

    const decimalsOut = buying ? token.decimals : funding.decimals;
    return {
      kind: 'confirm',
      intentId,
      quoteId: quote.id,
      message: 'Here is the fill. Confirm and I will sign it.',
      summary: {
        action: intent.action,
        token: `${token.symbol} (${token.name})`,
        contract: token.address,
        spend: `${amount} ${buying ? funding.symbol : token.symbol}`,
        receive: `~${formatUnits(quote.amountOut, decimalsOut)} ${buying ? token.symbol : funding.symbol}`,
        guaranteedMinimum: `${formatUnits(quote.minAmountOut, decimalsOut)} ${buying ? token.symbol : funding.symbol}`,
        poolFee: `${quote.feeTier / 10_000}%`,
        venue: `${token.symbol}/${funding.symbol}`,
      },
    };
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
      if (intent.status === 'executed' && intent.txHash) {
        return {
          kind: 'executed',
          intentId,
          txHash: intent.txHash,
          explorerUrl: explorerTxUrl(this.chain.explorer, intent.txHash),
          message: 'That trade already went through.',
        };
      }
      return { kind: 'rejected', message: 'That trade is already in flight.' };
    }

    const intent = this.store.get(intentId, sessionId);
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
