import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const wallets = pgTable('wallets', {
  id: uuid('id').defaultRandom().primaryKey(),
  // UNIQUE: one wallet per user, enforced by the database. An application
  // check alone loses a race between two concurrent sign-ups for one email.
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'restrict' })
    .notNull()
    .unique(),
  address: text('address').notNull().unique(),
  // AES-256-GCM envelope, with the address bound in as additional
  // authenticated data. Never plaintext; see WalletKeyService.
  encryptedKey: jsonb('encrypted_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Wallet = typeof wallets.$inferSelect;
