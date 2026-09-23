import { z } from 'zod';

/**
 * Validated once at boot so a missing key fails loudly on startup rather than
 * halfway through a trade. Never log the parsed result: it holds live secrets.
 */
export const envSchema = z.object({
  PORT: z.coerce.number().default(9000),
  /**
   * Comma-separated allowlist of browser origins.
   *
   * Outside production any localhost/127.0.0.1 port is also accepted, because
   * Next silently bumps to the next free port when 3000 is taken — so pinning
   * a single origin here means the UI gets CORS-blocked based on nothing but
   * what else happened to be running. Production still requires this list.
   */
  CORS_ORIGIN: z.string().default('http://localhost:3000,http://localhost:3001'),

  OPENSERV_AI_API_KEY: z.string().min(1, 'OPENSERV_AI_API_KEY is required'),
  /**
   * Opening the SERV tunnel on boot needs a reachable proxy, so it is opt-in.
   * The REST surface and the trading desk work without it.
   */
  ENABLE_OPENSERV_AGENT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Coinbase CDP — the agent's TEE-held signing key.
  CDP_API_KEY_ID: z.string().min(1, 'CDP_API_KEY_ID is required'),
  CDP_API_KEY_SECRET: z.string().min(1, 'CDP_API_KEY_SECRET is required'),
  CDP_WALLET_SECRET: z.string().min(1, 'CDP_WALLET_SECRET is required'),
  /**
   * Names the CDP server account reused across restarts so funding sticks.
   * One name is fine for both networks: a CDP account is an EVM address, the
   * same on mainnet and testnet, just with separate balances on each.
   */
  AGENT_ACCOUNT_NAME: z.string().default('arena67-agent'),

  /** How far back the pool index backfills on boot. */
  POOL_INDEX_SPAN: z.coerce.number().int().positive().default(200_000),

  /**
   * Which Robinhood Chain to run against. Defaults to mainnet on every
   * NODE_ENV; set to "testnet" to opt out.
   */
  ARENA_NETWORK: z.enum(['mainnet', 'testnet']).optional(),

  /** Overrides the network's default RPC. Must match the selected chain id. */
  RPC_URL: z.string().url().optional(),

  /**
   * Hard ceiling, in USD, on any single swap. The agent cannot be talked past
   * this by prompt injection: it is enforced in the orchestrator, after the
   * model has already produced its intent.
   */
  MAX_TRADE_USD: z.coerce.number().positive().default(25),
  /** Rejected above this; 100 = 1%. */
  MAX_SLIPPAGE_BPS: z.coerce.number().int().positive().max(5000).default(300),
});

export type Env = z.infer<typeof envSchema>;

export const validateEnv = (raw: Record<string, unknown>): Env => {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
};
