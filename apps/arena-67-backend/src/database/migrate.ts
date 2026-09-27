import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { resolve } from 'node:path';
import type { Database } from './database.module';

export const MIGRATIONS_DIR = resolve(__dirname, 'migrations');

/**
 * Applies pending migrations at boot.
 *
 * `vector` is created first because drizzle-kit does not emit extensions, and
 * the `messages` table's embedding column cannot be created without it. Run on
 * every boot, but both steps are idempotent: the extension is IF NOT EXISTS
 * and Drizzle records which migrations have already run.
 */
export async function migrate(
  db: Database,
  kind: 'pg' | 'pglite',
  log: Logger,
): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

  const migrator =
    kind === 'pg'
      ? await import('drizzle-orm/node-postgres/migrator')
      : await import('drizzle-orm/pglite/migrator');

  await migrator.migrate(db as never, { migrationsFolder: MIGRATIONS_DIR });
  log.log('Migrations applied.');
}
