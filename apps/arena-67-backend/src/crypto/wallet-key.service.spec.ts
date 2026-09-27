import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { WalletKeyService, isKeyEnvelope } from './wallet-key.service';

// Same stub as trading.service.spec: @nestjs/config ships ESM-only and jest
// cannot require() it under CJS. Only `get` is used, and it is supplied below.
jest.mock('@nestjs/config', () => ({ ConfigService: class ConfigService {} }));

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');

const PRIVATE_KEY =
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ALICE = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa';
const MALLORY = '0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb';

function service(env: Record<string, string | undefined>) {
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  return new WalletKeyService(config);
}

describe('WalletKeyService', () => {
  it('round-trips a private key', () => {
    const s = service({ WALLET_ENCRYPTION_KEY: KEY });
    const env = s.encrypt(PRIVATE_KEY, ALICE);
    expect(s.decrypt(env, ALICE)).toBe(PRIVATE_KEY);
  });

  it('never stores the key in plaintext', () => {
    const s = service({ WALLET_ENCRYPTION_KEY: KEY });
    const env = s.encrypt(PRIVATE_KEY, ALICE);
    expect(isKeyEnvelope(env)).toBe(true);
    expect(JSON.stringify(env)).not.toContain(PRIVATE_KEY.slice(2, 20));
  });

  it('uses a fresh IV every time, so equal keys do not produce equal rows', () => {
    const s = service({ WALLET_ENCRYPTION_KEY: KEY });
    const a = s.encrypt(PRIVATE_KEY, ALICE);
    const b = s.encrypt(PRIVATE_KEY, ALICE);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  // The attack AAD exists for: someone with write access copies Alice's
  // ciphertext into their own wallet row and asks the server to sign with it.
  it('refuses a ciphertext moved to another wallet', () => {
    const s = service({ WALLET_ENCRYPTION_KEY: KEY });
    const alicesRow = s.encrypt(PRIVATE_KEY, ALICE);
    expect(() => s.decrypt(alicesRow, MALLORY)).toThrow('could not be unlocked');
  });

  it('binds case-insensitively, so a checksummed address still decrypts', () => {
    const s = service({ WALLET_ENCRYPTION_KEY: KEY });
    const env = s.encrypt(PRIVATE_KEY, ALICE);
    expect(s.decrypt(env, ALICE.toLowerCase())).toBe(PRIVATE_KEY);
  });

  it('refuses to decrypt with the wrong master key', () => {
    const env = service({ WALLET_ENCRYPTION_KEY: KEY }).encrypt(PRIVATE_KEY, ALICE);
    const wrong = service({ WALLET_ENCRYPTION_KEY: OTHER_KEY });
    expect(() => wrong.decrypt(env, ALICE)).toThrow('could not be unlocked');
  });

  it('refuses a tampered ciphertext', () => {
    const s = service({ WALLET_ENCRYPTION_KEY: KEY });
    const env = s.encrypt(PRIVATE_KEY, ALICE);
    const bytes = Buffer.from(env.ct, 'base64');
    bytes[0] ^= 0xff;
    expect(() => s.decrypt({ ...env, ct: bytes.toString('base64') }, ALICE)).toThrow();
  });

  it('refuses something that is not an envelope rather than returning it', () => {
    const s = service({ WALLET_ENCRYPTION_KEY: KEY });
    // Grape passes non-envelopes through as plaintext for its lazy migration.
    // A plaintext private key must never be accepted here.
    expect(() => s.decrypt(PRIVATE_KEY, ALICE)).toThrow('not an encrypted envelope');
  });

  // The departure from grape that matters most.
  it('refuses to start with no key, instead of storing keys in the clear', () => {
    expect(() => service({})).toThrow('never stored unencrypted');
  });

  it('refuses a key of the wrong length', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => service({ WALLET_ENCRYPTION_KEY: short })).toThrow('32 bytes');
  });

  it('prefers the _DEV key outside production', () => {
    const s = service({
      NODE_ENV: 'development',
      WALLET_ENCRYPTION_KEY: KEY,
      WALLET_ENCRYPTION_KEY_DEV: OTHER_KEY,
    });
    expect(s.activeKeyName()).toBe('WALLET_ENCRYPTION_KEY_DEV');
  });

  it('ignores the _DEV key in production', () => {
    const s = service({
      NODE_ENV: 'production',
      WALLET_ENCRYPTION_KEY: KEY,
      WALLET_ENCRYPTION_KEY_DEV: OTHER_KEY,
    });
    expect(s.activeKeyName()).toBe('WALLET_ENCRYPTION_KEY');
  });
});
