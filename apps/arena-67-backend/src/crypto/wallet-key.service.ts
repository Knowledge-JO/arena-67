import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ENVELOPE_VERSION = 1;

/** How an encrypted private key sits in the `wallets.encrypted_key` column. */
export interface KeyEnvelope {
  v: number;
  iv: string;
  tag: string;
  ct: string;
}

export function isKeyEnvelope(value: unknown): value is KeyEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<KeyEnvelope>;
  return (
    c.v === ENVELOPE_VERSION &&
    typeof c.iv === 'string' &&
    typeof c.tag === 'string' &&
    typeof c.ct === 'string'
  );
}

/**
 * Encrypts wallet private keys at rest. AES-256-GCM, adapted from grape-ai's
 * EncryptionService with two deliberate departures.
 *
 * **It fails closed.** Grape's version returns the value untouched when no key
 * is configured, so a missing key degrades to plaintext rather than taking a
 * channel integration down. That trade is right for OAuth tokens and a lazy
 * migration. For private keys it would mean a misconfigured deploy silently
 * writing spendable keys into the database in the clear — so here, no key
 * means the service refuses to construct and the backend does not start.
 *
 * **Each ciphertext is bound to its wallet.** The address goes in as GCM
 * additional authenticated data. Without it, anyone with write access to the
 * `wallets` table could copy a victim's ciphertext into their own row and have
 * the server decrypt it and sign with it on their behalf. With it, the swapped
 * row fails authentication instead of decrypting.
 *
 * What this does not protect against is a compromised process: whoever runs
 * this code holds the master key in memory. That is inherent to custody.
 */
@Injectable()
export class WalletKeyService {
  private readonly log = new Logger(WalletKeyService.name);
  private readonly key: Buffer;
  private readonly keyName: string;

  constructor(config: ConfigService) {
    const { name, value } = this.selectKey(config);
    this.keyName = name;
    this.key = this.readKey(value, name);
    this.log.log(`Wallet keys encrypted with ${name}.`);
  }

  /**
   * Grape's convention: production reads the bare variable; anything else
   * prefers the `_DEV` twin. A dev machine therefore can never decrypt a
   * production wallet, and rotating one key does not disturb the other.
   */
  private selectKey(config: ConfigService): { name: string; value?: string } {
    const production = config.get<string>('NODE_ENV')?.trim() === 'production';
    if (!production) {
      const dev = config.get<string>('WALLET_ENCRYPTION_KEY_DEV');
      if (dev?.trim()) return { name: 'WALLET_ENCRYPTION_KEY_DEV', value: dev };
    }
    return {
      name: 'WALLET_ENCRYPTION_KEY',
      value: config.get<string>('WALLET_ENCRYPTION_KEY'),
    };
  }

  private readKey(raw: string | undefined, name: string): Buffer {
    if (!raw?.trim()) {
      throw new Error(
        `${name} is not set. Wallet private keys are never stored unencrypted, ` +
          `so the backend will not start without it. ` +
          `Generate one with: openssl rand -base64 32`,
      );
    }
    const key = Buffer.from(raw.trim(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `${name} must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
          `Generate one with: openssl rand -base64 32`,
      );
    }
    return key;
  }

  /**
   * @param privateKey 0x-prefixed hex private key.
   * @param address    The wallet's address — bound in as AAD.
   */
  encrypt(privateKey: string, address: string): KeyEnvelope {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    cipher.setAAD(this.aad(address));
    const ct = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
    return {
      v: ENVELOPE_VERSION,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    };
  }

  /**
   * Returns the private key, or throws.
   *
   * Throws rather than returning null — grape returns null so a channel can
   * reconnect, but a wallet that silently cannot decrypt would present as an
   * empty balance, which is exactly the wrong thing to show someone about
   * their money. A wrong key, a tampered row and a row moved to another
   * address all fail the same way, and none of them should look like "zero".
   */
  decrypt(stored: unknown, address: string): `0x${string}` {
    if (!isKeyEnvelope(stored)) {
      throw new Error('Stored wallet key is not an encrypted envelope.');
    }
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        this.key,
        Buffer.from(stored.iv, 'base64'),
      );
      decipher.setAAD(this.aad(address));
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(stored.ct, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return plain as `0x${string}`;
    } catch {
      // Deliberately vague: the message reaches logs, and "authentication
      // failed" is all anyone needs. The address is logged, never the key.
      this.log.error(`Wallet key failed authentication for ${address}.`);
      throw new Error('This wallet could not be unlocked.');
    }
  }

  /** Lowercased so a checksummed and a plain address bind identically. */
  private aad(address: string): Buffer {
    return Buffer.from(`arena67:wallet:${address.toLowerCase()}`, 'utf8');
  }

  activeKeyName(): string {
    return this.keyName;
  }
}
