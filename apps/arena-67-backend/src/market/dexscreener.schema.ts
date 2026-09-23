import { z } from 'zod';

/**
 * Shape of the Dexscreener token response, as a parser rather than a type.
 *
 * Everything here crosses a trust boundary: it is a third party describing
 * tokens that anyone can mint, including the name, the symbol and the links.
 * So it is parsed, not cast — and every numeric field is coerced, because the
 * API returns some of them as strings (`priceUsd`) and others as numbers
 * (`fdv`), which is exactly the kind of thing that silently produces NaN
 * downstream if you trust the declared type.
 */

const num = z.coerce.number().finite();

const TokenRef = z.object({
  address: z.string(),
  name: z.string().default(''),
  symbol: z.string().default(''),
});

const Info = z
  .object({
    imageUrl: z.string().url().optional(),
    header: z.string().url().optional(),
    websites: z
      .array(z.object({ url: z.string().url(), label: z.string().default('Website') }))
      .default([]),
    socials: z
      .array(z.object({ url: z.string().url(), type: z.string().default('link') }))
      .default([]),
  })
  .partial()
  .optional();

export const DexPair = z.object({
  chainId: z.string(),
  dexId: z.string().default(''),
  labels: z.array(z.string()).default([]),
  /** For Uniswap v4 this is the 32-byte poolId, not a 20-byte address. */
  pairAddress: z.string(),
  baseToken: TokenRef,
  quoteToken: TokenRef,
  priceUsd: num.optional(),
  priceNative: num.optional(),
  fdv: num.optional(),
  marketCap: num.optional(),
  liquidity: z.object({ usd: num.optional() }).partial().optional(),
  volume: z.object({ h24: num.optional() }).partial().optional(),
  priceChange: z.object({ h24: num.optional() }).partial().optional(),
  txns: z
    .object({
      h24: z.object({ buys: num.optional(), sells: num.optional() }).partial().optional(),
    })
    .partial()
    .optional(),
  pairCreatedAt: num.optional(),
  info: Info,
});

export const DexTokenResponse = z.object({
  pairs: z.array(DexPair).nullable().default([]),
});

export type DexPair = z.infer<typeof DexPair>;
