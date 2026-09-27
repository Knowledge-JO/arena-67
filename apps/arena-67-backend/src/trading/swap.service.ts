import { Injectable, Logger } from '@nestjs/common';
import {
  encodeAbiParameters,
  encodePacked,
  maxUint160,
  maxUint256,
  type WalletClient,
} from 'viem';
import { ChainService } from '../chain/chain.service';
import { NATIVE_TOKEN } from '../chain/networks';
import {
  UNIVERSAL_ROUTER_ABI,
  ERC20_ABI,
  PERMIT2_ABI,
  EXACT_INPUT_SINGLE_PARAMS,
  COMMAND_V4_SWAP,
  ACTION_SWAP_EXACT_IN_SINGLE,
  ACTION_SETTLE_ALL,
  ACTION_TAKE_ALL,
} from './uniswap-v4.abi';
import type { Quote } from './pending-intent.store';

/**
 * Whose funds, and the client that signs for them. Passed in rather than
 * injected: there is no longer one desk wallet, and a swap that reached for a
 * global signer could spend from the wrong user's account.
 */
export interface Signer {
  client: WalletClient;
  address: `0x${string}`;
}

export interface SwapParams {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  quote: Quote;
}

const DEADLINE_SECONDS = 120n;

/**
 * Builds and broadcasts a v4 exact-in swap through the UniversalRouter.
 *
 * The three-action shape is the canonical one from Uniswap's routing guide:
 * SWAP_EXACT_IN_SINGLE moves the funds inside the PoolManager's accounting,
 * SETTLE_ALL pays what we owe on the input side, TAKE_ALL collects the output.
 * Dropping either settle or take leaves a non-zero delta and the whole call
 * reverts, so all three always go together.
 */
@Injectable()
export class SwapService {
  private readonly log = new Logger(SwapService.name);

  constructor(private readonly chain: ChainService) {}

  private get v4() {
    return this.chain.network.uniswapV4;
  }

  async execute(params: SwapParams, signer: Signer): Promise<`0x${string}`> {
    const { tokenIn, tokenOut, quote } = params;
    const native = tokenIn.toLowerCase() === NATIVE_TOKEN.toLowerCase();

    if (!native) await this.ensurePermit2Allowance(tokenIn, quote.amountIn, signer);

    const [currency0, currency1] =
      tokenIn.toLowerCase() < tokenOut.toLowerCase()
        ? [tokenIn, tokenOut]
        : [tokenOut, tokenIn];
    const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();

    const swapParams = encodeAbiParameters(
      [EXACT_INPUT_SINGLE_PARAMS],
      [
        {
          poolKey: {
            currency0,
            currency1,
            fee: quote.feeTier,
            tickSpacing: quote.tickSpacing,
            hooks: quote.hooks,
          },
          zeroForOne,
          amountIn: quote.amountIn,
          amountOutMinimum: quote.minAmountOut,
          hookData: '0x',
        },
      ],
    );

    // SETTLE_ALL always names the currency going in, TAKE_ALL the one coming
    // out — not currency0/currency1, which only line up when zeroForOne.
    const settle = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [tokenIn, quote.amountIn],
    );
    const take = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [tokenOut, quote.minAmountOut],
    );

    const actions = encodePacked(
      ['uint8', 'uint8', 'uint8'],
      [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE_ALL, ACTION_TAKE_ALL],
    );
    const input = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      [actions, [swapParams, settle, take]],
    );
    const commands = encodePacked(['uint8'], [COMMAND_V4_SWAP]);

    const deadline =
      BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_SECONDS;

    // Simulate first. A revert here costs nothing; the same revert after
    // broadcast costs gas and leaves the user staring at a failed hash.
    const { request } = await this.chain.client.simulateContract({
      account: signer.address,
      address: this.v4.UNIVERSAL_ROUTER,
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [commands, [input], deadline],
      value: native ? quote.amountIn : 0n,
      chain: this.chain.network.chain,
    });

    const hash = await signer.client.writeContract(request);
    this.log.log(`swap broadcast ${hash} from ${signer.address}`);
    return hash;
  }

  async waitForReceipt(hash: `0x${string}`) {
    return this.chain.client.waitForTransactionReceipt({ hash, timeout: 90_000 });
  }

  /**
   * v4 pulls ERC-20s through Permit2, which needs two approvals: the token
   * must approve Permit2, and Permit2 must approve the router. Only relevant
   * when selling — a buy spends native ETH and carries it as msg.value.
   */
  private async ensurePermit2Allowance(
    token: `0x${string}`,
    amount: bigint,
    signer: Signer,
  ): Promise<void> {
    const owner = signer.address;

    const erc20Allowance = (await this.chain.client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, this.v4.PERMIT2],
    })) as bigint;

    if (erc20Allowance < amount) {
      const { request } = await this.chain.client.simulateContract({
        account: owner,
        address: token,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [this.v4.PERMIT2, maxUint256],
        chain: this.chain.network.chain,
      });
      const hash = await signer.client.writeContract(request);
      await this.chain.client.waitForTransactionReceipt({ hash });
      this.log.log(`approved Permit2 for ${token}`);
    }

    const [permitAmount, expiration] = (await this.chain.client.readContract({
      address: this.v4.PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [owner, token, this.v4.UNIVERSAL_ROUTER],
    })) as [bigint, number, number];

    const now = Math.floor(Date.now() / 1000);
    if (permitAmount < amount || expiration < now + 60) {
      const expiry = now + 30 * 24 * 60 * 60;
      const { request } = await this.chain.client.simulateContract({
        account: owner,
        address: this.v4.PERMIT2,
        abi: PERMIT2_ABI,
        functionName: 'approve',
        args: [token, this.v4.UNIVERSAL_ROUTER, maxUint160, expiry],
        chain: this.chain.network.chain,
      });
      const hash = await signer.client.writeContract(request);
      await this.chain.client.waitForTransactionReceipt({ hash });
      this.log.log(`approved router on Permit2 for ${token}`);
    }
  }
}
