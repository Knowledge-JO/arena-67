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

  constructor(private readonly config: ConfigService) {
    this.network = resolveNetwork(process.env);
    const rpc =
      this.config.get<string>('RPC_URL')?.trim() || this.network.defaultRpc;
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
    const id = await this.client.getChainId();
    if (id !== this.network.chainId) {
      throw new Error(
        `RPC reports chain ${id}, but ARENA_NETWORK=${this.network.name} ` +
          `expects ${this.network.chainId}. Check RPC_URL.`,
      );
    }
    const block = await this.client.getBlockNumber();
    const banner = this.network.realFunds
      ? 'MAINNET — trades spend real funds'
      : 'testnet — funds are not real';
    this.log.log(
      `${this.network.chain.name} (${id}) @ block ${block} · ${banner}`,
    );
  }

  get explorer(): string {
    return this.network.explorer;
  }
}
