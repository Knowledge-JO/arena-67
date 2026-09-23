import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isAddress, getAddress } from 'viem';
import { ChainService } from '../chain/chain.service';
import { PoolIndexService } from '../chain/pool-index.service';
import { ERC20_ABI } from './uniswap-v4.abi';
import type { TokenCandidate } from './pending-intent.store';

/**
 * Resolves what a user *said* into a specific contract on Robinhood Chain.
 *
 * This is the disambiguation step the product hinges on: "Trump" is not a
 * token, it is a name that dozens of contracts claim. The rule enforced here
 * is that a ticker never becomes an address implicitly — either the user typed
 * an address, or they pick one from a list we built.
 */
@Injectable()
export class TokensService {
  private readonly log = new Logger(TokensService.name);

  constructor(
    private readonly chain: ChainService,
    private readonly index: PoolIndexService,
  ) {}

  /** Reads a token's on-chain metadata; also serves as an existence check. */
  async describe(address: string): Promise<TokenCandidate | null> {
    if (!isAddress(address)) return null;
    const token = getAddress(address);
    try {
      const [symbol, name, decimals] = await Promise.all([
        this.chain.client.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'symbol',
        }),
        this.chain.client.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'name',
        }),
        this.chain.client.readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
      ]);
      return {
        id: randomUUID(),
        address: token,
        symbol: symbol as string,
        name: name as string,
        decimals: Number(decimals),
        liquidityUsd: 0,
        warnings: [],
      };
    } catch {
      this.log.warn(`${token} did not answer ERC-20 calls`);
      return null;
    }
  }

  async balanceOf(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
    return (await this.chain.client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner],
    })) as bigint;
  }

  /**
   * Candidate lookup by ticker, served from the pool index.
   *
   * A token is only offered if some pool trades it, which is both the honest
   * definition of tradeable here and a weak spam filter: a contract nobody has
   * opened a market for is almost never the one being asked about. Ranking
   * still is not proof of authenticity, so candidates carry a warning when
   * several tokens share a symbol and the user has to choose deliberately.
   */
  async findByTicker(ticker: string): Promise<TokenCandidate[]> {
    const hits = await this.index.search(ticker);
    const ambiguous = hits.length > 1;
    return hits.map((t) => ({
      id: randomUUID(),
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      liquidityUsd: 0,
      warnings: [
        `${t.poolCount} pool${t.poolCount === 1 ? '' : 's'}`,
        ...(ambiguous ? ['several tokens share this ticker — check the address'] : []),
      ],
    }));
  }
}
