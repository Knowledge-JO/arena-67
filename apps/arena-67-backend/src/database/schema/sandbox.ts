import {
  doublePrecision,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Paper trading. Entirely separate from `trades` and the user's wallet:
 * nothing here is ever signed, and nothing real is ever written here.
 *
 * `epoch` is how reset works — it starts a new epoch and every query reads
 * the current one, so old trades are kept rather than deleted.
 */
export const paperAccounts = pgTable('paper_accounts', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  epoch: integer('epoch').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  resetAt: timestamp('reset_at', { withTimezone: true }),
});

/**
 * One row per asset held. `amount` is in base units (numeric(78,0) fits any
 * uint256). `costUsd` is what the current amount cost, for unrealised profit;
 * `realizedUsd` accumulates profit locked in by sells. ETH and WETH share the
 * native row.
 */
export const paperBalances = pgTable(
  'paper_balances',
  {
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    epoch: integer('epoch').notNull(),
    asset: text('asset').notNull(),
    symbol: text('symbol').notNull(),
    decimals: integer('decimals').notNull(),
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    realizedUsd: doublePrecision('realized_usd').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.epoch, t.asset] })],
);

export const paperTrades = pgTable(
  'paper_trades',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    epoch: integer('epoch').notNull(),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    tokenAddress: text('token_address').notNull(),
    tokenSymbol: text('token_symbol').notNull(),
    poolId: text('pool_id').notNull(),
    fundingAddress: text('funding_address').notNull(),
    fundingSymbol: text('funding_symbol').notNull(),
    /** Base units of what was spent and what came back. */
    amountIn: numeric('amount_in', { precision: 78, scale: 0 }).notNull(),
    amountOut: numeric('amount_out', { precision: 78, scale: 0 }).notNull(),
    /** Dollar value of the trade at fill time. */
    valueUsd: doublePrecision('value_usd'),
    /** Simulated network fee, in dollars, and which balance paid it. */
    feeUsd: doublePrecision('fee_usd').notNull().default(0),
    feeAsset: text('fee_asset'),
    /** Profit locked in by a sell; null on buys. */
    realizedUsd: doublePrecision('realized_usd'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('paper_trades_user_idx').on(t.userId, t.epoch, t.createdAt)],
);

export const paperDeposits = pgTable(
  'paper_deposits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    epoch: integer('epoch').notNull(),
    asset: text('asset').notNull(),
    symbol: text('symbol').notNull(),
    amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
    /** Dollar value when deposited — what profit is measured against. */
    valueUsd: doublePrecision('value_usd').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('paper_deposits_user_idx').on(t.userId, t.epoch)],
);
