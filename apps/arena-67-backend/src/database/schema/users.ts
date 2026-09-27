import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  // Stored lowercased and trimmed; uniqueness is on the normalised form so
  // "Me@x.com" and "me@x.com" cannot become two accounts with two wallets.
  email: text('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  /**
   * Sandbox (paper money on mainnet prices) or live (the user's own wallet).
   * Server-side, because it decides whether a confirm can reach the signer —
   * a browser flag could be edited. Sandbox by default.
   */
  tradingMode: text('trading_mode', { enum: ['sandbox', 'live'] }).notNull().default('sandbox'),
});

export type User = typeof users.$inferSelect;
