import {
  bigint,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Who holds each indexed token, rebuilt from its Transfer logs.
 *
 * Balances, not transfers: a row is "this address holds this much right now".
 * That answers who holds, and who holds several, at a fraction of the storage
 * raw transfers would take — but it cannot answer "who bought in the last
 * hour". See TODO-research.md, Decision 2.
 *
 * `numeric(78,0)` because a uint256 does not fit in anything smaller, and
 * memecoin supplies routinely use most of it. Zero balances are deleted rather
 * than kept, so the row count is the holder count.
 */
export const tokenHolders = pgTable(
  'token_holders',
  {
    token: text('token').notNull(),
    holder: text('holder').notNull(),
    balance: numeric('balance', { precision: 78, scale: 0 }).notNull(),
    updatedBlock: bigint('updated_block', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.token, t.holder] }),
    index('token_holders_token_balance_idx').on(t.token, t.balance),
    index('token_holders_holder_idx').on(t.holder),
  ],
);

/**
 * Indexing progress per token.
 *
 * `cursor_block` is the last block whose transfers are fully folded into
 * `token_holders`, and it advances in the same transaction as the balances it
 * covers — so a crash mid-backfill resumes where it stopped instead of
 * counting a chunk twice.
 */
export const tokenIndexState = pgTable(
  'token_index_state',
  {
    token: text('token').primaryKey(),
    /** queued | indexing | ready | failed */
    status: text('status').notNull(),
    /** Higher runs first: 3 asked for by a user, 2 top volume, 1 held by a user. */
    priority: integer('priority').notNull().default(0),
    /** First block with a transfer. Null until the backfill finds one. */
    fromBlock: bigint('from_block', { mode: 'bigint' }),
    cursorBlock: bigint('cursor_block', { mode: 'bigint' }),
    transfersSeen: bigint('transfers_seen', { mode: 'number' }).notNull().default(0),
    lastError: text('last_error'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /** Live-tailed while this is in the future; left to go stale after. */
    trackedUntil: timestamp('tracked_until', { withTimezone: true }),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('token_index_state_status_idx').on(t.status, t.priority)],
);

/**
 * What kind of address a holder is: wallet, pool, burn, contract, token.
 *
 * Without this, "who holds the most" is the Uniswap PoolManager for every
 * token on the chain. Contract labels are permanent — code does not change
 * once deployed. Wallet labels are rechecked after a day, because a
 * counterfactual address can have a contract deployed to it later.
 */
export const addressLabels = pgTable('address_labels', {
  address: text('address').primaryKey(),
  label: text('label').notNull(),
  /** Human description where we have one, e.g. "Uniswap v4 pools". */
  name: text('name'),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
});
