import { parseUnits } from 'viem';
import { TradingService } from './trading.service';
import { PendingIntentStore, type Quote } from './pending-intent.store';
import type { TokensService } from './tokens.service';
import type { QuoteService } from './quote.service';
import type { SwapService } from './swap.service';
import type { WalletService } from '../wallet/wallet.service';
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

const FIXED_QUOTE: Quote = {
  id: 'quote-1',
  amountIn: parseUnits('10', 6),
  amountOut: 9_990_000n,
  minAmountOut: 9_909_000n,
  priceImpactBps: 0,
  feeTier: 500,
  tickSpacing: 10,
  hooks: '0x0000000000000000000000000000000000000000',
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
    balanceOf: jest.fn(),
  };
  const wallet = {
    available: true,
    address: '0x1234567890123456789012345678901234567890',
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
  const chain = { network: NETWORK, explorer: NETWORK.explorer };
  const index = { poolsFor: jest.fn() };

  const service = new TradingService(
    store,
    quotes as unknown as QuoteService,
    swaps as unknown as SwapService,
    tokens as unknown as TokensService,
    wallet as unknown as WalletService,
    config as unknown as import('@nestjs/config').ConfigService,
    chain as unknown as ChainService,
    index as unknown as PoolIndexService,
  );

  return { store, quotes, swaps, tokens, wallet, chain, index, service };
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

    expect(step.kind).toBe('need_amount');
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
    expect(next.kind).toBe('need_amount');
  });

  it('rejects a non-positive amount instead of pretending it is a trade', async () => {
    const { service, tokens } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    const created = await service.begin(
      's1',
      intent({ ticker: undefined, contractAddress: TOKEN.address }),
    );
    if (created.kind !== 'need_amount') throw new Error('expected need_amount');

    const bad = await service.setAmount('s1', created.intentId, 0);
    expect(bad.kind).toBe('rejected');
    expect(bad.message).toMatch(/not a positive number/);
  });

  it('refuses a spend over the USD cap, evaluating the real dollar value', async () => {
    const { service, tokens, index } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    // No pools for any base pair: funding falls back to the network default (tUSDG).
    index.poolsFor.mockReturnValue([]);

    const step = await service.begin(
      's1',
      intent({ amount: 1000, contractAddress: TOKEN.address }),
    );

    expect(step.kind).toBe('rejected');
    expect(step.message).toMatch(/about \$1000\.00/);
    expect(step.message).toMatch(/\$25 per-trade cap/);
  });

  it('lets a small buy through and price it via the on-chain quoter', async () => {
    const { service, tokens, index, quotes, wallet } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);
    quotes.quoteExactIn.mockResolvedValue(FIXED_QUOTE);
    wallet.available = false;

    const step = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
    );

    expect(step.kind).toBe('confirm');
    expect(quotes.quoteExactIn).toHaveBeenCalledWith({
      tokenIn: BASE_USDG.address,
      tokenOut: TOKEN.address,
      amountIn: parseUnits('10', 6),
      maxSlippageBps: 300,
    });
  });

  it('refuses a named currency with no pool rather than silently substituting', async () => {
    const { service, tokens, index } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockImplementation((a: string, b: string) =>
      a === BASE_WETH.address && b === TOKEN.address ? ['p1'] : [],
    );

    const step = await service.begin(
      's1',
      intent({ amount: 10, currency: 'USDG', contractAddress: TOKEN.address }),
    );

    expect(step.kind).toBe('rejected');
    expect(step.message).toMatch(/no tUSDG pool/);
    expect(step.message).toMatch(/It trades against WETH/);
  });

  it('refuses a funding asset it does not trade', async () => {
    const { service, tokens } = build();
    tokens.describe.mockResolvedValue(TOKEN);

    const step = await service.begin(
      's1',
      intent({ amount: 10, currency: 'DOGE', contractAddress: TOKEN.address }),
    );

    expect(step.kind).toBe('rejected');
    expect(step.message).toMatch(/do not trade DOGE/);
  });

  it('rejects when the agent wallet holds too little of the spent asset', async () => {
    const { service, tokens, index, wallet } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);
    wallet.available = true;
    tokens.balanceOf.mockResolvedValue(parseUnits('1', 6));

    const step = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
    );

    expect(step.kind).toBe('rejected');
    expect(step.message).toMatch(/only holds/);
  });

  it('signs and reports a fill after an explicit confirm', async () => {
    const { service, tokens, index, quotes, swaps, wallet } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);
    quotes.quoteExactIn.mockResolvedValue(FIXED_QUOTE);
    wallet.available = true;
    tokens.balanceOf.mockResolvedValue(parseUnits('100', 6));
    swaps.execute.mockResolvedValue('0xdeadbeef');
    swaps.waitForReceipt.mockResolvedValue({ status: 'success' });

    const quoted = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
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
    wallet.available = true;
    tokens.balanceOf.mockResolvedValue(parseUnits('100', 6));
    swaps.execute.mockResolvedValue('0xdeadbeef');
    swaps.waitForReceipt.mockResolvedValue({ status: 'success' });

    const quoted = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
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

  it('reports that a wallet-less desk can only research, not sign', async () => {
    const { service, tokens, index, quotes, wallet } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);
    quotes.quoteExactIn.mockResolvedValue(FIXED_QUOTE);
    wallet.available = false;

    const step = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
    );
    if (step.kind === 'need_amount') void step;
    // The price step itself still works read-only...
    const confirm = step.kind === 'confirm' ? step : null;
    if (!confirm) throw new Error('expected a quote even without a wallet');
    const rejected = await service.confirm(
      's1',
      confirm.intentId,
      confirm.quoteId,
    );
    expect(rejected.kind).toBe('rejected');
    expect(rejected.message).toMatch(/offline/);
  });

  it('surfaces a reverted on-chain transaction as a rejected fill', async () => {
    const { service, tokens, index, quotes, swaps, wallet } = build();
    tokens.describe.mockResolvedValue(TOKEN);
    index.poolsFor.mockReturnValue([]);
    quotes.quoteExactIn.mockResolvedValue(FIXED_QUOTE);
    wallet.available = true;
    tokens.balanceOf.mockResolvedValue(parseUnits('100', 6));
    swaps.execute.mockResolvedValue('0xdeadbeef');
    swaps.waitForReceipt.mockResolvedValue({ status: 'reverted' });

    const quoted = await service.begin(
      's1',
      intent({ amount: 10, contractAddress: TOKEN.address }),
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
