import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CdpClient } from '@coinbase/cdp-sdk';
import { ViemWalletProvider } from '@coinbase/agentkit';
import { createWalletClient, http, formatEther, type WalletClient } from 'viem';
import { toAccount } from 'viem/accounts';
import { ChainService } from '../chain/chain.service';

/**
 * The agent's wallet.
 *
 * AgentKit's `CdpEvmWalletProvider` cannot be used directly here: its network
 * union is hard-coded to base / ethereum / polygon / arbitrum / optimism, and
 * Robinhood Chain (4663) is not in it. Pointing `networkId` at this chain, as
 * the original plan assumed, does not work.
 *
 * The way through is that the restriction only covers CDP's *managed* actions
 * (transfer, swap, faucet). The underlying `EvmServerAccount.signTransaction`
 * is network-agnostic, so we keep the TEE custody story — the private key
 * never leaves Coinbase's enclave — and do the broadcasting ourselves:
 *
 *   CDP server account  ->  viem LocalAccount (toAccount)
 *                       ->  viem WalletClient on chain 4663
 *                       ->  AgentKit ViemWalletProvider
 *
 * The AgentKit action model still wraps everything, so custom actions and the
 * AgentKit track both still apply.
 */
@Injectable()
export class WalletService implements OnModuleInit {
  private readonly log = new Logger(WalletService.name);

  private _walletClient?: WalletClient;
  private _provider?: ViemWalletProvider;
  private _address?: `0x${string}`;
  private _unavailable: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly chain: ChainService,
  ) {}

  /**
   * A missing signer is not a fatal condition.
   *
   * Everything the research side does — the pool index, token search, quotes,
   * trending — is read-only and works fine without a wallet. Only signing
   * needs one. Killing the process here took the whole desk down because the
   * key service was unreachable, which is the wrong trade: the arena should
   * still answer "what is moving and what would this cost" while it cannot
   * answer "sign this".
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      this._unavailable = (err as Error).message;
      this.log.error(`Agent wallet unavailable — trading disabled. ${this._unavailable}`);
      this.log.warn('Read-only mode: research, search and quotes still work.');
    }
  }

  private async connect(): Promise<void> {
    const cdp = new CdpClient({
      apiKeyId: this.config.getOrThrow<string>('CDP_API_KEY_ID'),
      apiKeySecret: this.config.getOrThrow<string>('CDP_API_KEY_SECRET'),
      walletSecret: this.config.getOrThrow<string>('CDP_WALLET_SECRET'),
    });

    // Named + get-or-create so the funded address survives restarts. A fresh
    // address every boot would mean re-funding before every demo run.
    //
    // Wrapped in a timeout because the CDP SDK does not impose one: if
    // api.cdp.coinbase.com is unreachable — a blocked egress rule, a corporate
    // proxy, an offline laptop — this call simply never settles and Nest hangs
    // mid-boot with no error at all. Failing loudly in 20s beats a silent hang.
    const server = await this.withTimeout(
      cdp.evm.getOrCreateAccount({
        name: this.config.getOrThrow<string>('AGENT_ACCOUNT_NAME'),
      }),
      20_000,
      'Could not reach the Coinbase CDP API (api.cdp.coinbase.com). ' +
        'Check network egress and that CDP_API_KEY_ID / CDP_API_KEY_SECRET / ' +
        'CDP_WALLET_SECRET are set correctly.',
    );

    this._address = server.address as `0x${string}`;

    const account = toAccount({
      address: this._address,
      signMessage: ({ message }) => server.signMessage({ message }),
      signTransaction: (tx) => server.signTransaction(tx),
      signTypedData: (typedData) => server.signTypedData(typedData as never),
    });

    this._walletClient = createWalletClient({
      account,
      chain: this.chain.network.chain,
      transport: http(this.config.getOrThrow<string>('RPC_URL')),
    });

    this._provider = new ViemWalletProvider(this._walletClient);

    const balance = await this.chain.client.getBalance({
      address: this._address,
    });
    this.log.log(
      `Agent wallet ${this._address} on ${this.chain.network.name} — ` +
        `${formatEther(balance)} ETH for gas`,
    );
    if (balance === 0n) {
      this.log.warn(
        `Agent wallet holds no ETH. Fund ${this._address} on ` +
          `${this.chain.network.chain.name} before trading` +
          (this.chain.network.realFunds
            ? '.'
            : ' — https://faucet.testnet.chain.robinhood.com'),
      );
    }
  }

  /** False when the signer never came up; callers must check before signing. */
  get available(): boolean {
    return !!this._address && !this._unavailable;
  }

  get unavailableReason(): string | null {
    return this._unavailable;
  }

  /** Null rather than throwing — the UI shows the header without an address. */
  get addressOrNull(): `0x${string}` | null {
    return this._address ?? null;
  }

  get address(): `0x${string}` {
    if (!this._address) {
      throw new Error(this._unavailable ?? 'Agent wallet is not available.');
    }
    return this._address;
  }

  get walletClient(): WalletClient {
    if (!this._walletClient) {
      throw new Error(this._unavailable ?? 'Agent wallet is not available.');
    }
    return this._walletClient;
  }

  get provider(): ViemWalletProvider {
    if (!this._provider) {
      throw new Error(this._unavailable ?? 'Agent wallet is not available.');
    }
    return this._provider;
  }

  private async withTimeout<T>(
    work: Promise<T>,
    ms: number,
    message: string,
  ): Promise<T> {
    let timer: NodeJS.Timeout;
    const bell = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
      return await Promise.race([work, bell]);
    } finally {
      clearTimeout(timer!);
    }
  }
}
