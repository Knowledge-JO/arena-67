import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { CODE_LENGTH } from './auth.constants';

/**
 * A uniformly random numeric code.
 *
 * `randomInt` draws from a CSPRNG without modulo bias. `Math.random` would be
 * predictable, and `randomBytes % 10` would make some digits likelier than
 * others — both shrink a space that is only a million wide to begin with.
 */
export function generateCode(): string {
  const max = 10 ** CODE_LENGTH;
  return randomInt(0, max).toString().padStart(CODE_LENGTH, '0');
}

/**
 * Codes are stored hashed, grape's discipline for every token at rest.
 *
 * The email is mixed in so a leaked table cannot be attacked with one
 * precomputed table of all million codes — each row has to be cracked for its
 * own address. It is still a million guesses per row, which is why the code
 * also expires in minutes and burns after five wrong attempts.
 */
export function hashCode(email: string, code: string): string {
  return createHash('sha256').update(`${email}:${code}`).digest('hex');
}

export function codesMatch(expectedHash: string, email: string, code: string): boolean {
  const a = Buffer.from(expectedHash, 'hex');
  const b = Buffer.from(hashCode(email, code), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Lowercased and trimmed, so one mailbox cannot become two accounts. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
