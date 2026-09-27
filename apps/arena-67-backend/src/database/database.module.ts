import { Global, Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';
import { DRIZZLE } from './database.constants';
import { migrate } from './migrate';

/** Startup attempts before giving up: 2+4+8+16+32s of patience. */
const STARTUP_ATTEMPTS = 6;

/**
 * Both drivers produce a Drizzle Postgres database over the same schema, so
 * nothing above this module knows or cares which one it got.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

interface Handle {
  db: Database;
  kind: 'pg' | 'pglite';
  close: () => Promise<void>;
}

/**
 * Picks a driver at startup.
 *
 * `DATABASE_URL` set → real Postgres over `pg`, grape's convention and the
 * production target. Unset → PGlite: Postgres compiled to WASM, running
 * in-process, persisted to a directory.
 *
 * PGlite is here so the stack runs with no Docker and no database server, and
 * because it is the only way this code can be exercised from an environment
 * without one. It is the same engine and the same SQL, so the schema and every
 * query are identical — but it is single-connection and in-process, which is
 * fine for development and wrong for production.
 */
async function connect(config: ConfigService, log: Logger): Promise<Handle> {
  const url = config.get<string>('DATABASE_URL')?.trim();

  if (url) {
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pool = new Pool({ connectionString: url });
    // A connection dropped by the network emits 'error' on the pool (idle
    // clients) or on the client itself (checked out). With no listener, Node
    // treats that as fatal and the whole server exits over one blip. Logged
    // instead: the pool discards the broken client, and the query that was
    // using it fails on its own and is retried by whoever issued it.
    pool.on('error', (err) => log.warn(`database connection dropped (idle): ${err.message}`));
    pool.on('connect', (client) => {
      client.on('error', (err) => log.warn(`database connection dropped: ${err.message}`));
    });
    log.log('Database: Postgres via DATABASE_URL');
    return {
      db: drizzle(pool, { schema }) as unknown as Database,
      kind: 'pg',
      close: () => pool.end(),
    };
  }

  const dir = resolve(config.get<string>('PGLITE_DIR') ?? './.data/arena67');
  mkdirSync(dir, { recursive: true });

  const { PGlite } = await import('@electric-sql/pglite');
  // pgvector left the core package in PGlite 0.5; it ships separately.
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { drizzle } = await import('drizzle-orm/pglite');

  const client = new PGlite(dir, { extensions: { vector } });
  await client.waitReady;
  log.warn(`Database: embedded PGlite at ${dir} — development only`);

  return {
    db: drizzle(client, { schema }) as unknown as Database,
    kind: 'pglite',
    close: () => client.close(),
  };
}

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: async (config: ConfigService): Promise<Handle> => {
        const log = new Logger('Database');
        const handle = await connect(config, log);
        // The first query is where an unreachable database shows up. Retried
        // with backoff so a network blip at boot delays startup by seconds
        // instead of killing the process; persistent failure still exits.
        for (let attempt = 1; ; attempt++) {
          try {
            await migrate(handle.db, handle.kind, log);
            return handle;
          } catch (err) {
            if (attempt >= STARTUP_ATTEMPTS) throw err;
            const wait = 2_000 * 2 ** (attempt - 1);
            log.warn(
              `database not reachable (attempt ${attempt}/${STARTUP_ATTEMPTS}): ` +
                `${(err as Error).message || (err as { code?: string }).code}; retrying in ${wait / 1000}s`,
            );
            await new Promise((r) => setTimeout(r, wait));
          }
        }
      },
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DRIZZLE) private readonly handle: Handle) {}

  async onModuleDestroy() {
    await this.handle.close();
  }
}

/** Unwraps the handle; inject `DRIZZLE` and call this to get the database. */
export const dbOf = (handle: unknown): Database => (handle as Handle).db;
