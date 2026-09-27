import dotenv from 'dotenv';

dotenv.config({ quiet: true });

/**
 * Reads configuration the same way the rest of the stack does: production uses
 * the bare variable, anything else prefers a `_DEV` twin and falls back.
 */
export function env(name: string): string | undefined {
  const production = process.env.NODE_ENV?.trim() === 'production';

  if (!production) {
    const dev = process.env[`${name}_DEV`];
    if (dev?.trim()) return dev.trim();
  }

  return process.env[name]?.trim();
}
