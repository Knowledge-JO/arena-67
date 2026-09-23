import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseUnits, formatUnits } from 'viem';
import { PendingIntentStore, type PendingIntent } from './pending-intent.store';
import { QuoteService } from './quote.service';
import { SwapService } from './swap.service';
import { TokensService } from './tokens.service';
import { WalletService } from '../wallet/wallet.service';
import { NATIVE_TOKEN, explorerTxUrl, type BaseToken } from '../chain/networks';
import { ChainService } from '../chain/chain.service';
import { PoolIndexService } from '../chain/pool-index.service';
import type { TradeIntent } from '../openserv/schemas';

/** What the orchestrator hands back to the chat on every turn. */
export type TradeStep =
  | { kind: 'need_token'; intentId: string; ticker?: string; message: string }
  | {
      kind: 'choose_token';
      intentId: string;
      message: string;
      candidates: PendingIntent['candidates'];
    }
  | { kind: 'need_amount'; intentId: string; symbol: string; message: string }
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
    private readonly wallet: WalletService,
    private readonly config: ConfigService,
    private readonly chain: ChainService,
    private readonly index: PoolIndexService,
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

    if (!intent.amount) {
      return {
        kind: 'need_amount',
        intentId: intent.id,
        symbol: intent.token.symbol,
        message: `How much do you want to ${intent.action}?`,
      };
    }

    return this.priceIt(sessionId, intent.id);
  }

  async selectToken(
    sessionId: string,
    intentId: string,
    candidateId: string,
  ): Promise<TradeStep> {
    this.store.selectCandidate(intentId, sessionId, candidateId);
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

    const picked = this.pickFunding(token.address, intent.currency);
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

    // Check the balance of whatever is actually being spent, funding asset
    // included — a buy fails just as hard with no USDG as a sell does with no
    // tokens, and finding that out after signing wastes gas. Skipped without a
    // signer: there is no wallet to weigh, and a quote is still worth showing.
    if (tokenIn !== NATIVE_TOKEN && this.wallet.available) {
      const spending = buying ? funding : token;
      const held = await this.tokens.balanceOf(
        tokenIn as `0x${string}`,
        this.wallet.address,
      );
      if (held < amountIn) {
        return {
          kind: 'rejected',
          message: `The agent wallet only holds ${formatUnits(held, spending.decimals)} ${spending.symbol}.`,
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
    if (!this.wallet.available) {
      return {
        kind: 'rejected',
        message:
          'The agent wallet is offline, so nothing can be signed right now. ' +
          'Quotes and research still work.',
      };
    }

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

    try {
      // Read back what was quoted rather than re-deriving it.
      const funding = intent.funding;
      if (!funding) {
        return { kind: 'rejected', message: 'That quote is incomplete. Start again.' };
      }
      const hash = await this.swaps.execute({
        tokenIn: buying ? funding.address : token.address,
        tokenOut: buying ? token.address : funding.address,
        quote: intent.quote!,
      });

      const receipt = await this.swaps.waitForReceipt(hash);
      if (receipt.status !== 'success') {
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
      this.store.patch(intentId, sessionId, { status: 'failed', error: message });
      this.log.error(`swap failed for intent ${intentId}: ${message}`);
      return { kind: 'rejected', message: `The swap could not be completed: ${message}` };
    }
  }

  /**
   * Chooses what a buy actually spends, from the pools that exist.
   *
   * USDG was hardcoded here, which measurement proved wrong: microduck has 225
   * pools on mainnet and every one of them pairs against native ETH. Memecoins
   * quote in ETH on this chain; USDG is mostly for stock tokens and stables.
   * So the funding asset is picked by looking for a pool, not by assumption.
   *
   * When the user *names* a currency and no pool exists for it, this refuses
   * rather than substituting. Silently re-reading "25 USDG" as 25 ETH would
   * turn a $25 order into a $68,000 one — a substitution is never safe when
   * the number stays the same and only the unit moves.
   */
  private pickFunding(
    token: `0x${string}`,
    currency?: string,
  ): { token: BaseToken } | { error: string } {
    const { baseTokens, funding } = this.chain.network;
    const named = currency?.trim().toUpperCase();

    if (named) {
      const asked = baseTokens[named];
      if (!asked) {
        return {
          error: `I do not trade ${named} as a funding asset on this network.`,
        };
      }
      if (this.index.poolsFor(asked.address, token).length === 0) {
        const alt = this.fundingWithPools(token);
        return {
          error:
            `There is no ${asked.symbol} pool for that token` +
            (alt ? `. It trades against ${alt.symbol} — try that instead.` : '.'),
        };
      }
      return { token: asked };
    }

    const found = this.fundingWithPools(token);
    return { token: found ?? funding };
  }

  /** The base asset with the deepest pool coverage against this token. */
  private fundingWithPools(token: `0x${string}`): BaseToken | null {
    const seen = new Set<string>();
    let best: { token: BaseToken; pools: number } | null = null;
    for (const candidate of Object.values(this.chain.network.baseTokens)) {
      const key = candidate.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const pools = this.index.poolsFor(candidate.address, token).length;
      if (pools > 0 && (!best || pools > best.pools)) {
        best = { token: candidate, pools };
      }
    }
    return best?.token ?? null;
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
