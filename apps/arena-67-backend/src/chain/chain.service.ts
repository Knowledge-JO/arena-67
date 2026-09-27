import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, http, type PublicClient } from 'viem';
import { RpcLimiter } from './rpc-limiter';
import { resolveNetwork, type NetworkConfig } from './networks';

/** Read-side client, bound to whichever Robinhood Chain network is selected. */
@Injectable()
export class ChainService implements OnModuleInit {
  private readonly log = new Logger(ChainService.name);

  readonly network: NetworkConfig;
  /** For anything a person is waiting on: quotes, trades, prices, reports. */
  readonly client: PublicClient;
  /**
   * For indexing, tailing and scanning. Same endpoint, same shared budget,
   * but it queues behind interactive work and holds only a few of the slots.
   */
  readonly backgroundClient: PublicClient;
  private readonly limiter: RpcLimiter;
  private rateLimited = 0;
  private head: { block: bigint; at: number } | null = null;
  private headInflight: Promise<bigint> | null = null;
  /** The RPC in use, so signers broadcast through the same endpoint we read from. */
  readonly rpcUrl: string;

  constructor(private readonly config: ConfigService) {
    this.network = resolveNetwork(process.env);
    const rpc =
      this.config.get<string>('RPC_URL')?.trim() || this.network.defaultRpc;
    this.rpcUrl = rpc;
    this.limiter = new RpcLimiter({
      maxConcurrent: this.config.get<number>('RPC_MAX_CONCURRENCY') ?? 8,
      maxPerSecond: this.config.get<number>('RPC_MAX_RPS') ?? 10,
      maxBackground: this.config.get<number>('RPC_BACKGROUND_CONCURRENCY') ?? 3,
    });
    const make = (background: boolean) =>
      createPublicClient({
        chain: this.network.chain,
        transport: http(rpc, {
          retryCount: 4,
          retryDelay: 1500,
          timeout: 45_000,
          // Every request waits its turn in the shared budget.
          fetchFn: (input, init) =>
            this.limiter.run(background, () => fetch(input, init)),
          onFetchResponse: (res) => {
            if (res.status === 429) this.rateLimited += 1;
          },
        }),
      }) as PublicClient;
    this.client = make(false);
    this.backgroundClient = make(true);
    // Refused requests are retried with backoff; if it still happens the
    // budget is too high for this endpoint, which is worth one line a minute.
    setInterval(() => {
      if (this.rateLimited > 0) {
        this.log.warn(
          `RPC refused ${this.rateLimited} request(s) with 429 in the last minute (retried). ` +
            'Lower RPC_MAX_RPS / RPC_MAX_CONCURRENCY, or set RPC_URL to a dedicated endpoint.',
        );
        this.rateLimited = 0;
      }
    }, 60_000).unref();
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
        this.log.warn(
          `RPC not reachable (attempt ${attempt}/${attempts}); retrying in ${wait / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  /**
   * The latest block, shared: at least five services poll for it, and each
   * asking separately was a steady stream of identical requests. Cached for
   * two seconds (about twenty blocks here), with concurrent callers sharing
   * one request.
   */
  async latestBlock(): Promise<bigint> {
    if (this.head && Date.now() - this.head.at < 2_000) return this.head.block;
    if (this.headInflight) return this.headInflight;
    this.headInflight = this.backgroundClient
      .getBlockNumber()
      .then((block) => {
        this.head = { block, at: Date.now() };
        return block;
      })
      .finally(() => {
        this.headInflight = null;
      });
    return this.headInflight;
  }

  get explorer(): string {
    return this.network.explorer;
  }
}
