import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  createWalletClient,
  formatEther,
  http,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DRIZZLE } from '../database/database.constants';
import { dbOf, type Database } from '../database/database.module';
import { wallets } from '../database/schema';
import { WalletKeyService } from '../crypto/wallet-key.service';
import { ChainService } from '../chain/chain.service';

/** A transaction handle for creating a wallet inside the sign-up transaction. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Per-user custodial wallets. Replaces the single CDP agent wallet.
 *
 * The private key exists in plaintext in exactly two places, both transient:
 * inside `create` between generation and encryption, and inside `withSigner`
 * for the duration of one signing callback. It is never returned, logged,
 * stored unencrypted, or passed to the model.
 */
@Injectable()
export class UserWalletService {
  private readonly log = new Logger(UserWalletService.name);
  private readonly db: Database;

  constructor(
    @Inject(DRIZZLE) handle: unknown,
    private readonly keys: WalletKeyService,
    private readonly chain: ChainService,
  ) {
    this.db = dbOf(handle);
  }

  /**
   * Creates the wallet for a new user, inside the caller's transaction.
   *
   * It has to be the same transaction as the user row. Otherwise a crash
   * between the two leaves an account with no wallet — and the unique
   * constraint on `user_id` means a retry could never repair it.
   */
  async create(tx: Tx, userId: string): Promise<string> {
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;
    const encryptedKey = this.keys.encrypt(privateKey, address);

    await tx.insert(wallets).values({ userId, address, encryptedKey });
    this.log.log(`wallet created for user ${userId}: ${address}`);
    return address;
  }

  async addressOf(userId: string): Promise<`0x${string}`> {
    const row = await this.db.query.wallets.findFirst({
      where: eq(wallets.userId, userId),
      columns: { address: true },
    });
    if (!row) throw new NotFoundException('No wallet for this account.');
    return row.address as `0x${string}`;
  }

  async nativeBalance(userId: string): Promise<{ address: string; wei: bigint; eth: string }> {
    const address = await this.addressOf(userId);
    const wei = await this.chain.client.getBalance({ address });
    return { address, wei, eth: formatEther(wei) };
  }

  /**
   * Lends out a signer for the duration of one callback.
   *
   * A callback rather than a returned client, so the decrypted key's lifetime
   * is bounded by this function — nothing can hold onto a signer and use it
   * later, and the key is not reachable from anything the caller keeps.
   * JavaScript cannot truly zero a string, so "dropped" means unreferenced and
   * left to the collector; the scope is kept as small as the language allows.
   */
  async withSigner<T>(
    userId: string,
    work: (client: WalletClient, address: `0x${string}`) => Promise<T>,
  ): Promise<T> {
    const row = await this.db.query.wallets.findFirst({
      where: eq(wallets.userId, userId),
    });
    if (!row) throw new NotFoundException('No wallet for this account.');

    const address = row.address as `0x${string}`;
    const account = privateKeyToAccount(this.keys.decrypt(row.encryptedKey, address));

    // Belt and braces: the AAD check already binds key to address, but a
    // derived address that disagrees with the row means something is badly
    // wrong, and signing anyway would send funds from an unexpected account.
    if (account.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error('Wallet key does not match its recorded address.');
    }

    const client = createWalletClient({
      account,
      chain: this.chain.network.chain,
      transport: http(this.chain.rpcUrl),
    });
    return work(client, address);
  }

  /**
   * The user's own key, for export. Only ever called behind a fresh code —
   * see AccountsController. Export is what guarantees a user's funds survive
   * this service disappearing, so it exists despite being the most dangerous
   * operation in the product.
   */
  async exportPrivateKey(userId: string): Promise<{ address: string; privateKey: string }> {
    const row = await this.db.query.wallets.findFirst({ where: eq(wallets.userId, userId) });
    if (!row) throw new NotFoundException('No wallet for this account.');
    this.log.warn(`private key exported for user ${userId} (${row.address})`);
    return {
      address: row.address,
      privateKey: this.keys.decrypt(row.encryptedKey, row.address),
    };
  }
}
