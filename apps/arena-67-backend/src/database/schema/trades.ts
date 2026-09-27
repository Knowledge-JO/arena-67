import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';
import { conversations } from './conversations';

/**
 * Every trade the desk signs. "What did I buy?" is answered from here, not by
 * semantic search over chat — a query is exact where recall is approximate.
 */
export const trades = pgTable(
  'trades',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    side: text('side', { enum: ['buy', 'sell'] }).notNull(),
    tokenAddress: text('token_address').notNull(),
    tokenSymbol: text('token_symbol').notNull(),
    poolId: text('pool_id').notNull(),
    fundingSymbol: text('funding_symbol').notNull(),
    // Decimal strings of base units: bigint does not survive JSON, and floats
    // would round a real amount of someone's money.
    amountIn: text('amount_in').notNull(),
    amountOut: text('amount_out'),
    txHash: text('tx_hash'),
    status: text('status', { enum: ['pending', 'confirmed', 'failed'] }).notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('trades_user_idx').on(t.userId, t.createdAt)],
);

export type Trade = typeof trades.$inferSelect;
