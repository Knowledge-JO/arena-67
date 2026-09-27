import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * One-time passcodes. Keyed by email rather than user because the same flow
 * serves sign-up, where no user row exists yet.
 */
export const loginCodes = pgTable(
  'login_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    // SHA-256 of the code. The raw value exists only in the email; a leaked
    // table of hashes of six-digit numbers is still brute-forceable offline,
    // which is why the codes also expire in minutes and burn after five tries.
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    // Set when a newer code supersedes this one, so only the latest works.
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    requestIp: text('request_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('login_codes_email_idx').on(t.email)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
    // SHA-256 of the raw token, which is only ever sent to the client once.
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('refresh_tokens_hash_idx').on(t.tokenHash),
    index('refresh_tokens_user_idx').on(t.userId),
  ],
);
