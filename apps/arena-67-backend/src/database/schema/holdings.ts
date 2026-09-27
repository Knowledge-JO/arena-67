import { bigint, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Tokens ever sent to one of our wallets, found by scanning Transfer logs.
 *
 * Discovery, not balances: a row means "this wallet has received this token at
 * some point", which is the set worth checking. Balances are read live from
 * the chain at portfolio time, so a token sold to zero simply shows nothing.
 */
export const walletTokens = pgTable(
  'wallet_tokens',
  {
    walletAddress: text('wallet_address').notNull(),
    tokenAddress: text('token_address').notNull(),
    firstSeenBlock: bigint('first_seen_block', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.walletAddress, t.tokenAddress] }),
    index('wallet_tokens_wallet_idx').on(t.walletAddress),
  ],
);

/**
 * Single-row cursors for background scans. The holdings scanner stores the
 * last block it has fully processed, so a restart resumes rather than
 * rescanning or skipping.
 */
export const syncState = pgTable('sync_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
