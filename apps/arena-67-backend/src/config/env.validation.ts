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

  /**
   * Postgres. Unset → embedded PGlite under ./.data, for development only.
   * See DatabaseModule for why both exist.
   */
  /** Blank counts as unset, so `DATABASE_URL=` switches to embedded PGlite. */
  DATABASE_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  PGLITE_DIR: z.string().optional(),

  /** Signs session and per-turn MCP tokens. 32+ characters. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  /**
   * Master key for wallet private keys, base64 of 32 bytes. Validated for
   * length by WalletKeyService, which also refuses to start without it.
   * Production should source this from a KMS, not a file next to the DB URL.
   */
  WALLET_ENCRYPTION_KEY: z.string().optional(),
  WALLET_ENCRYPTION_KEY_DEV: z.string().optional(),

  /** SMTP. Unset in development prints login codes to the log instead. */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /** "true" for implicit TLS (usually port 465); otherwise STARTTLS is required. */
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** "Arena 67 <codes@example.com>" or a bare address. */
  SMTP_FROM_EMAIL: z.string().optional(),

  /**
   * Shared with the MCP server so the backend can tell its own services from
   * anonymous callers. Unset means callers are unidentified, which is fine
   * locally and not fine once this is reachable from anywhere else.
   */
  SERVICE_SECRET: z.string().min(16, 'Use at least 16 characters').optional(),

  /**
   * Turns identification into enforcement: only callers presenting
   * SERVICE_SECRET get through. Leave false while the browser UI talks to this
   * backend directly — a browser cannot hold a secret.
   */
  REQUIRE_SERVICE_AUTH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /** SERV Reasoning — OpenAI-shaped inference. */
  SERV_API_URL: z.string().url().default('https://inference-api.openserv.ai'),
  SERV_MODEL: z.string().default('claude-haiku-4.5'),

  /** Where the desk finds its own tools. */
  MCP_URL: z.string().url().default('http://localhost:5100/mcp'),
  /** Shared secret the MCP server requires on its inbound gate. */
  MCP_TOKEN: z.string().optional(),

  /**
   * Tool-calling rounds per message. A model that misreads a result will call
   * the same tool indefinitely, and each pass costs tokens and requests.
   */
  /** Tokens whose holder history is rebuilt at once. Each is a stream of getLogs calls. */
  HOLDER_INDEX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /**
   * Tokens with more holders than this are not indexed. Tokenised stocks run
   * to 100k+ holders each and filled a 512 MB database on their own.
   */
  HOLDER_INDEX_MAX_HOLDERS: z.coerce.number().int().min(1_000).default(50_000),
  /** Holder data for tokens nobody has asked about in this many days is deleted. */
  HOLDER_INDEX_RETAIN_DAYS: z.coerce.number().int().min(1).default(7),
  AGENT_MAX_TURNS: z.coerce.number().int().min(1).max(10).default(5),

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
   * The RPC budget, shared by everything. Defaults suit the public endpoint
   * (it refuses bursts of ~15+); raise them with a paid RPC_URL.
   */
  RPC_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(8),
  RPC_MAX_RPS: z.coerce.number().int().min(1).max(1000).default(10),
  /** In-flight slots background indexing may use, out of RPC_MAX_CONCURRENCY. */
  RPC_BACKGROUND_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(3),

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
