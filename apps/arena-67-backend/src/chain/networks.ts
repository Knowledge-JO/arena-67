import { defineChain, type Chain } from 'viem';

export type NetworkName = 'mainnet' | 'testnet';

export interface BaseToken {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

export interface NetworkConfig {
  name: NetworkName;
  chain: Chain;
  chainId: number;
  defaultRpc: string;
  explorer: string;
  uniswapV4: {
    POOL_MANAGER: `0x${string}`;
    POSITION_MANAGER: `0x${string}`;
    QUOTER: `0x${string}`;
    STATE_VIEW: `0x${string}`;
    UNIVERSAL_ROUTER: `0x${string}`;
    PERMIT2: `0x${string}`;
  };
  multicall3: `0x${string}`;
  /** What an unqualified amount is denominated in on this network. */
  funding: BaseToken;
  /** Everything else quotable by name, keyed by upper-case symbol. */
  baseTokens: Record<string, BaseToken>;
  /** True when losing a trade costs actual money. */
  realFunds: boolean;
}

/** v4 core is at identical addresses on both networks — verified by bytecode. */
const UNISWAP_V4 = {
  POOL_MANAGER: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  POSITION_MANAGER: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  QUOTER: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  STATE_VIEW: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  UNIVERSAL_ROUTER: '0x8876789976decbfcbbbe364623c63652db8c0904',
  PERMIT2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
} as const;

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export const NATIVE_TOKEN =
  '0x0000000000000000000000000000000000000000' as const;

const MAINNET_USDG: BaseToken = {
  address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  symbol: 'USDG',
  decimals: 6,
};
const MAINNET_WETH: BaseToken = {
  address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  symbol: 'WETH',
  decimals: 18,
};

/**
 * tUSDG is the testnet's dominant quote asset and mirrors USDG's 6 decimals,
 * so the decimal handling that matters most is exercised for real rather than
 * papered over by an 18-decimal stand-in.
 */
const TESTNET_USDG: BaseToken = {
  address: '0x8174360fbC52557C91390403B78158f85Ba37255',
  symbol: 'tUSDG',
  decimals: 6,
};

const NATIVE_ETH: BaseToken = {
  address: NATIVE_TOKEN,
  symbol: 'ETH',
  decimals: 18,
};

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  mainnet: {
    name: 'mainnet',
    chainId: 4663,
    defaultRpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com',
    chain: defineChain({
      id: 4663,
      name: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
      blockExplorers: {
        default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
      },
    }),
    uniswapV4: UNISWAP_V4,
    multicall3: MULTICALL3,
    funding: MAINNET_USDG,
    baseTokens: { USDG: MAINNET_USDG, WETH: MAINNET_WETH, ETH: NATIVE_ETH },
    realFunds: true,
  },

  testnet: {
    name: 'testnet',
    chainId: 46630,
    defaultRpc: 'https://rpc.testnet.chain.robinhood.com/rpc',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
    chain: defineChain({
      id: 46630,
      name: 'Robinhood Chain Testnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: {
        default: { http: ['https://rpc.testnet.chain.robinhood.com/rpc'] },
      },
      blockExplorers: {
        default: {
          name: 'Explorer',
          url: 'https://explorer.testnet.chain.robinhood.com',
        },
      },
      testnet: true,
    }),
    uniswapV4: UNISWAP_V4,
    multicall3: MULTICALL3,
    // Mainnet's USDG/WETH contracts do not exist here, so USDG maps to tUSDG.
    funding: TESTNET_USDG,
    baseTokens: { USDG: TESTNET_USDG, TUSDG: TESTNET_USDG, ETH: NATIVE_ETH },
    realFunds: false,
  },
};

/**
 * Picks the network. Mainnet is the default on every NODE_ENV; testnet is an
 * opt-in via `ARENA_NETWORK=testnet`.
 *
 * Dev deliberately points at mainnet so the flow being tested is the real one
 * — testnet liquidity is thin and synthetic, and a quote there tells you the
 * plumbing works but not what a trade actually costs.
 *
 * The safety that matters therefore is not this default. It is the per-trade
 * MAX_TRADE_USD cap, the quote-and-confirm gate before anything is signed, and
 * ChainService refusing to boot when the RPC's chain id disagrees with the
 * selected network. Those hold regardless of how the network was chosen.
 */
export function resolveNetwork(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  const explicit = env.ARENA_NETWORK?.trim().toLowerCase();
  if (explicit === 'mainnet' || explicit === 'testnet') return NETWORKS[explicit];
  if (explicit) {
    throw new Error(
      `ARENA_NETWORK must be "mainnet" or "testnet", got "${explicit}".`,
    );
  }
  return NETWORKS.mainnet;
}

export const explorerTxUrl = (explorer: string, hash: string) =>
  `${explorer}/tx/${hash}`;
