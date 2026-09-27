import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, type PublicClient } from 'viem';
import { resolveNetwork, type NetworkConfig } from './networks';

/** Read-side client, bound to whichever Robinhood Chain network is selected. */
@Injectable()
export class ChainService implements OnModuleInit {
  private readonly log = new Logger(ChainService.name);

  readonly network: NetworkConfig;
  readonly client: PublicClient;
  /** The RPC in use, so signers broadcast through the same endpoint we read from. */
  readonly rpcUrl: string;

  constructor(private readonly config: ConfigService) {
    this.network = resolveNetwork(process.env);
    const rpc =
      this.config.get<string>('RPC_URL')?.trim() || this.network.defaultRpc;
    this.rpcUrl = rpc;
    this.client = createPublicClient({
      chain: this.network.chain,
      transport: http(rpc, { retryCount: 4, retryDelay: 1500, timeout: 45_000 }),
    });
  }

  /**
   * Refuses to start if the RPC is not the network we think it is — which also
   * catches an RPC_URL left pointing at mainnet while ARENA_NETWORK says
   * testnet, the one mismatch that would quietly spend real money.
   */
  async onModuleInit(): Promise<void> {
    const id = await this.reachChain();
    if (id !== this.network.chainId) {
      throw new Error(
        `RPC reports chain ${id}, but ARENA_NETWORK=${this.network.name} ` +
          `expects ${this.network.chainId}. Check RPC_URL.`,
      );
    }
    // Cosmetic: a failed read here must not stop the boot.
    const block = await this.client.getBlockNumber().catch(() => 'unknown');
    const banner = this.network.realFunds
      ? 'MAINNET — trades spend real funds'
      : 'testnet — funds are not real';
    this.log.log(
      `${this.network.chain.name} (${id}) @ block ${block} · ${banner}`,
    );
  }

  /**
   * The chain id, retried while the RPC is unreachable. Only reachability is
   * retried: an RPC that answers with the wrong chain still refuses to boot
   * straight away, in onModuleInit.
   */
  private async reachChain(attempts = 6): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.client.getChainId();
      } catch (err) {
        if (attempt >= attempts) throw err;
        const wait = 2_000 * 2 ** (attempt - 1);
        this.log.warn(`RPC not reachable (attempt ${attempt}/${attempts}); retrying in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  get explorer(): string {
    return this.network.explorer;
  }
}
