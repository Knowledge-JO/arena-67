import { parseUnits } from 'viem';
import { TradingService } from './trading.service';
import { PendingIntentStore, type Quote } from './pending-intent.store';
import type { TokensService } from './tokens.service';
import type { QuoteService } from './quote.service';
import type { SwapService } from './swap.service';
import type { UserWalletService } from '../accounts/user-wallet.service';
import type { TradeLedgerService } from '../accounts/trade-ledger.service';
import type { ChainService } from '../chain/chain.service';
import type { PoolIndexService } from '../chain/pool-index.service';
import type { BaseToken, NetworkConfig } from '../chain/networks';
import type { TokenCandidate } from './pending-intent.store';
import type { TradeIntent } from '../openserv/schemas';

// @nestjs/config/@nestjs/schedule ship ESM-only dist that jest cannot
// require() under CJS, and emitDecoratorMetadata forces the real DI graph to
// load (pool-index -> schedule, swap -> wallet -> coinbase SDKs). Those
// packages are outside the unit under test, so stub them out. The only runtime
// uses: ConfigService.getOrThrow, Cron decorators, and the wallet SDK classes
// whose behaviour SwapService is mocked for.
jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));
jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_MINUTE: '* * * * *', EVERY_5_MINUTES: '*/5 * * * *' },
}));
jest.mock('@coinbase/cdp-sdk', () => ({ CdpClient: class CdpClient {} }));
jest.mock('@coinbase/agentkit', () => ({
  ViemWalletProvider: class ViemWalletProvider {},
}));

const NATIVE = '0x0000000000000000000000000000000000000000';

const TOKEN: TokenCandidate = {
  id: 'token-1',
  address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  symbol: 'ANIME',
  name: 'Anime One',
  decimals: 18,
  liquidityUsd: 0,
  warnings: [],
};

const BASE_USDG: BaseToken = {
  address: '0x1111111111111111111111111111111111111111',
  symbol: 'tUSDG',
  decimals: 6,
};
const BASE_WETH: BaseToken = {
  address: '0x2222222222222222222222222222222222222222',
  symbol: 'WETH',
  decimals: 18,
};
const BASE_ETH: BaseToken = {
  address: NATIVE,
  symbol: 'ETH',
  decimals: 18,
};

const NETWORK = {
  name: 'testnet',
  chainId: 46630,
  defaultRpc: '',
  explorer: 'https://explorer.testnet.example',
  uniswapV4: {
    POOL_MANAGER: '0x0000000000000000000000000000000000000000',
    POSITION_MANAGER: '0x0000000000000000000000000000000000000000',
    QUOTER: '0x0000000000000000000000000000000000000000',
    STATE_VIEW: '0x0000000000000000000000000000000000000000',
    UNIVERSAL_ROUTER: '0x0000000000000000000000000000000000000000',
    PERMIT2: '0x0000000000000000000000000000000000000000',
  },
  multicall3: '0x0000000000000000000000000000000000000000',
  funding: BASE_USDG,
  baseTokens: { USDG: BASE_USDG, WETH: BASE_WETH, ETH: BASE_ETH },
  realFunds: false,
} as unknown as NetworkConfig;

const POOL_ID =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

/** The venue the token page offers, and the PoolKey it resolves to. */
const POOL_ROW = {
  poolId: POOL_ID,
  quoteSymbol: 'tUSDG',
  quoteAddress: BASE_USDG.address,
  liquidityUsd: 50_000,
  priceUsd: 1,
  collapsed: 0,
  source: 'dexscreener' as const,
};

const POOL_RECORD = {
  id: POOL_ID,
  currency0: BASE_USDG.address,
  currency1: TOKEN.address,
  fee: 500,
  tickSpacing: 10,
  hooks: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  block: 1n,
};

const MARKET = {
  address: TOKEN.address,
  symbol: TOKEN.symbol,
  name: TOKEN.name,
  imageUrl: null,
  websites: [],
  socials: [],
  stats: null,
  pools: [POOL_ROW],
  degraded: false,
};

const FIXED_QUOTE: Quote = {
  id: 'quote-1',
  amountIn: parseUnits('10', 6),
  amountOut: 9_990_000n,
  minAmountOut: 9_909_000n,
  priceImpactBps: 0,
  feeTier: 500,
  tickSpacing: 10,
  hooks: '0x0000000000000000000000000000000000000000',
  poolId: POOL_ID,
  quotedAt: Date.now(),
};

function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return { action: 'buy', ticker: 'ANIME', ...overrides };
}

function build() {
  const store = new PendingIntentStore();
  const quotes = { quoteExactIn: jest.fn() };
  const swaps = { execute: jest.fn(), waitForReceipt: jest.fn() };
  const tokens = {
    describe: jest.fn(),
    findByTicker: jest.fn(),
    // Enough by default; tests about insufficient funds override it.
    balanceOf: jest.fn().mockResolvedValue(parseUnits('1000000', 6)),
  };
  // Per-user wallets: the service asks for an address, and borrows a signer
  // for one callback. The mock runs the callback the way the real one does.
  const WALLET = '0x1234567890123456789012345678901234567890' as `0x${string}`;
  const wallet = {
    addressOf: jest.fn().mockResolvedValue(WALLET),
    withSigner: jest.fn(
      (_userId: string, work: (c: unknown, a: `0x${string}`) => Promise<unknown>) =>
        work({}, WALLET),
    ),
  };
  const ledger = {
    open: jest.fn().mockResolvedValue('trade-1'),
    settle: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    getOrThrow: jest.fn((key: string) =>
      key === 'MAX_TRADE_USD'
        ? 25
        : key === 'MAX_SLIPPAGE_BPS'
          ? 300
          : undefined,
    ),
  };
  const chain = {
    network: NETWORK,
    explorer: NETWORK.explorer,
    client: { getBalance: jest.fn().mockResolvedValue(parseUnits('100', 18)) },
  };
  const index = {
    poolsFor: jest.fn(),
    poolsForToken: jest.fn().mockReturnValue([]),
    resolveForToken: jest.fn().mockResolvedValue(POOL_RECORD),
  };
  const market = { forToken: jest.fn().mockResolvedValue(MARKET) };

  const service = new TradingService(
    store,
    quotes as unknown as QuoteService,
    swaps as unknown as SwapService,
    tokens as unknown as TokensService,
    wallet as unknown as UserWalletService,
    config as unknown as import('@nestjs/config').ConfigService,
    chain as unknown as ChainService,
    index as unknown as PoolIndexService,
    market as unknown as import('../market/market.service').MarketService,
    ledger as unknown as TradeLedgerService,
  );

  return { store, quotes, swaps, tokens, wallet, chain, index, market, ledger, service };
}

/**
 * v2 puts a venue choice between the token and the price, so anything that
 * asserts on a quote has to walk through it. Returns the intent id.
 */
async function pickVenue(
  service: TradingService,
  session: string,
  step: Awaited<ReturnType<TradingService['begin']>>,
): Promise<string> {
  if (step.kind !== 'token_detail') {
    throw new Error(`expected token_detail, got ${step.kind}`);
  }
  await service.selectPool(session, step.intentId, POOL_ID);
  return step.intentId;
}

describe('TradingService', () => {
  it('asks for the amount when the user names a token but not a number', async () => {
    const { service, tokens, index } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);

    const step = await service.begin(
      's1',
      intent({ contractAddress: TOKEN.address }),
    );

    // v2: a token with no amount lands on the token page, which carries the
    // venues to choose from. The amount is asked for once one is picked.
    expect(step.kind).toBe('token_detail');
    if (step.kind !== 'token_detail') throw new Error('expected token_detail');
    expect(step.pools).toHaveLength(1);
    expect(step.selectedPoolId).toBeUndefined();
  });

  it('asks the user to disambiguate when a ticker matches several tokens', async () => {
    const { service, tokens } = build();
    tokens.findByTicker.mockResolvedValue([
      { ...TOKEN, name: 'Anime One' },
      { ...TOKEN, id: 'token-2', name: 'Anime Two', poolCount: 1 },
    ]);

    const step = await service.begin(
      's1',
      intent({ amount: 10, currency: 'USDG' }),
    );
    expect(step.kind).toBe('choose_token');
  });

  it('pastes a picked candidate into the trade and proceeds to the amount', async () => {
    const { service, tokens } = build();
    tokens.findByTicker.mockResolvedValue([TOKEN]);

    const begin = await service.begin('s1', intent({}));
    if (begin.kind !== 'choose_token') throw new Error('expected choose_token');
    const next = await service.selectToken('s1', begin.intentId, TOKEN.id);
    expect(next.kind).toBe('token_detail');
  });

  it('rejects a non-positive amount instead of pretending it is a trade', async () => {
    const { service, tokens } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    const created = await service.begin(
      's1',
      intent({ ticker: undefined, contractAddress: TOKEN.address }),
    );
    if (created.kind !== 'token_detail') throw new Error('expected token_detail');

    const bad = await service.setAmount('s1', created.intentId, 0);
    expect(bad.kind).toBe('rejected');
    expect(bad.message).toMatch(/not a positive number/);
  });

  it('refuses a spend over the USD cap, evaluating the real dollar value', async () => {
    const { service, tokens, index } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    // No pools for any base pair: funding falls back to the network default (tUSDG).
    index.poolsFor.mockReturnValue([]);

    const begun = await service.begin(
      's1',
      intent({ amount: 1000, contractAddress: TOKEN.address }),
    );
    const id = await pickVenue(service, 's1', begun);
    const step = await service.advance('s1', id);

    expect(step.kind).toBe('rejected');
    expect(step.message).toMatch(/about \$1000\.00/);
    expect(step.message).toMatch(/\$25 per-trade cap/);
  });

  it('lets a small buy through and price it via the on-chain quoter', async () => {
    const { service, tokens, index, quotes } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);
    quotes.quoteExactIn.mockResolvedValue(FIXED_QUOTE);

    const begun = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
    );
    const id = await pickVenue(service, 's1', begun);
    const step = await service.advance('s1', id);

    expect(step.kind).toBe('confirm');
    // The chosen pool must reach the quoter. Without it the quoter races every
    // candidate and could fill through a venue the card never showed.
    expect(quotes.quoteExactIn).toHaveBeenCalledWith({
      tokenIn: BASE_USDG.address,
      tokenOut: TOKEN.address,
      amountIn: parseUnits('10', 6),
      maxSlippageBps: 300,
      pool: POOL_RECORD,
    });
  });

  // The two tests that stood here covered `pickFunding`: a named currency with
  // no pool, and a funding asset the desk does not trade. Both described v1,
  // where the desk guessed a funding asset from the user's stated preference
  // and a pool search. v2 removes that guess entirely — the user picks a venue
  // and the funding asset is whichever side of that pool is not the token, so
  // neither failure can arise. The guards below are what replaced them.

  it('refuses a pool the token page never offered', async () => {
    const { service, tokens, index } = build();
    tokens.describe.mockResolvedValue(TOKEN);

    const begun = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
    );
    if (begun.kind !== 'token_detail') throw new Error('expected token_detail');

    const other =
      '0x2222222222222222222222222222222222222222222222222222222222222222';
    const step = await service.selectPool('s1', begun.intentId, other);

    expect(step.kind).toBe('rejected');
    expect(step.message).toMatch(/not one of the listed pools/);
    // It must not even be resolved: an unlisted id is refused before we touch
    // the chain on its behalf.
    expect(index.resolveForToken).not.toHaveBeenCalled();
  });

  it('refuses a listed pool that turns out not to trade this token', async () => {
    const { service, tokens, index } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    // A poolId is opaque and reaches us via the browser from a third-party
    // API, so the recovered PoolKey is what proves the pair.
    index.resolveForToken.mockRejectedValue(
      new Error('That pool does not trade this token.'),
    );

    const begun = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
    );
    if (begun.kind !== 'token_detail') throw new Error('expected token_detail');

    const step = await service.selectPool('s1', begun.intentId, POOL_ID);

    expect(step.kind).toBe('rejected');
    expect(step.message).toMatch(/does not trade this token/);
  });

  it('derives the funding asset from the chosen pool, not from preferences', async () => {
    const { service, tokens, quotes, wallet } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    quotes.quoteExactIn.mockResolvedValue(FIXED_QUOTE);

    // The user asks to spend WETH, but the venue they pick is tUSDG/TOKEN.
    // The pool wins: it is the thing that can actually fill.
    const begun = await service.begin(
      's1',
      intent({ amount: 10, currency: 'WETH', contractAddress: TOKEN.address }),
    );
    const id = await pickVenue(service, 's1', begun);
    const step = await service.advance('s1', id);

    expect(step.kind).toBe('confirm');
    if (step.kind !== 'confirm') throw new Error('expected confirm');
    expect(step.summary.spend).toContain('tUSDG');
    expect(step.summary.venue).toBe(`${TOKEN.symbol}/tUSDG`);
  });

  it('rejects when the agent wallet holds too little of the spent asset', async () => {
    const { service, tokens, index, wallet } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);
    tokens.balanceOf.mockResolvedValue(parseUnits('1', 6));

    const begun = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
    );
    const id = await pickVenue(service, 's1', begun);
    const step = await service.advance('s1', id);

    expect(step.kind).toBe('rejected');
    expect(step.message).toMatch(/not enough for this trade/);
  });

  it('signs and reports a fill after an explicit confirm', async () => {
    const { service, tokens, index, quotes, swaps, wallet } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);
    quotes.quoteExactIn.mockResolvedValue(FIXED_QUOTE);
    tokens.balanceOf.mockResolvedValue(parseUnits('100', 6));
    swaps.execute.mockResolvedValue('0xdeadbeef');
    swaps.waitForReceipt.mockResolvedValue({ status: 'success' });

    const begun = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
    );
    const quoted = await service.advance(
      's1',
      await pickVenue(service, 's1', begun),
    );
    if (quoted.kind !== 'confirm') throw new Error('expected confirm');

    const done = await service.confirm('s1', quoted.intentId, quoted.quoteId);
    if (done.kind !== 'executed') throw new Error('expected executed');
    expect(done.message).toMatch(/filled/);
    expect(done.explorerUrl).toContain('https://explorer.testnet.example/tx/');
  });

  it('will not sign twice for the same confirm', async () => {
    const { service, tokens, index, quotes, swaps, wallet } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);
    quotes.quoteExactIn.mockResolvedValue(FIXED_QUOTE);
    tokens.balanceOf.mockResolvedValue(parseUnits('100', 6));
    swaps.execute.mockResolvedValue('0xdeadbeef');
    swaps.waitForReceipt.mockResolvedValue({ status: 'success' });

    const begun = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
    );
    const quoted = await service.advance(
      's1',
      await pickVenue(service, 's1', begun),
    );
    if (quoted.kind !== 'confirm') throw new Error('expected confirm');

    const first = await service.confirm('s1', quoted.intentId, quoted.quoteId);
    const second = await service.confirm('s1', quoted.intentId, quoted.quoteId);

    expect(swaps.execute).toHaveBeenCalledTimes(1);
    if (first.kind !== 'executed' || second.kind !== 'executed') {
      throw new Error('both confirms must resolve');
    }
    expect(second.message).toMatch(/already went through/);
  });

  // Replaces "a wallet-less desk can only research": with per-user wallets
  // there is no desk-wide offline state. The failure that remains is a single
  // user's key that will not unlock — a wrong master key, a tampered row, a
  // ciphertext moved to another address. That must refuse cleanly, never sign,
  // and never leave the trade looking as if it went through.
  it('refuses cleanly when the user wallet cannot be unlocked', async () => {
    const { service, tokens, index, quotes, wallet, swaps, ledger } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);
    quotes.quoteExactIn.mockResolvedValue(FIXED_QUOTE);
    wallet.withSigner.mockRejectedValue(new Error('This wallet could not be unlocked.'));

    const begun = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
    );
    const step = await service.advance('s1', await pickVenue(service, 's1', begun));
    if (step.kind !== 'confirm') throw new Error('expected confirm');

    const rejected = await service.confirm('s1', step.intentId, step.quoteId);

    expect(rejected.kind).toBe('rejected');
    expect(rejected.message).toMatch(/could not be unlocked/);
    expect(swaps.execute).not.toHaveBeenCalled();
    // The pre-broadcast ledger row must be settled as failed, not left pending
    // forever as if a transaction might still be in flight. Asserted
    // positively: a check that it was *not* confirmed passes just as happily
    // when settle is never called at all, which is the bug this guards.
    expect(ledger.open).toHaveBeenCalledTimes(1);
    expect(ledger.settle).toHaveBeenCalledWith(
      'trade-1',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('surfaces a reverted on-chain transaction as a rejected fill', async () => {
    const { service, tokens, index, quotes, swaps, wallet } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);
    quotes.quoteExactIn.mockResolvedValue(FIXED_QUOTE);
    tokens.balanceOf.mockResolvedValue(parseUnits('100', 6));
    swaps.execute.mockResolvedValue('0xdeadbeef');
    swaps.waitForReceipt.mockResolvedValue({ status: 'reverted' });

    const begun = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
    );
    const quoted = await service.advance(
      's1',
      await pickVenue(service, 's1', begun),
    );
    if (quoted.kind !== 'confirm') throw new Error('expected confirm');
    const rejected = await service.confirm(
      's1',
      quoted.intentId,
      quoted.quoteId,
    );

    expect(rejected.kind).toBe('rejected');
    expect(rejected.message).toMatch(/reverted on-chain/);
  });
});
