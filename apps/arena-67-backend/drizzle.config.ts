import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Generates SQL migrations from the schema. Migrations are applied at boot by
 * src/database/migrate.ts, so this is only needed when the schema changes:
 *
 *   npx drizzle-kit generate
 */
export default defineConfig({
  schema: './src/database/schema/index.ts',
  out: './src/database/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
