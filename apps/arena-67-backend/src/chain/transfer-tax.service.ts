import { Injectable, Logger } from '@nestjs/common';
import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { ChainService } from './chain.service';

/**
 * A token's own transfer tax, measured rather than guessed.
 *
 * Some memecoins take a cut of every transfer. The Uniswap quoter prices the
 * pool, not the token, so for those tokens every quote — paper or real —
 * overstates what arrives. This measures the tax directly: in a single
 * eth_call, the probe below is placed (by state override, never deployed) at
 * the Uniswap v4 PoolManager address and at a helper address. Running as the
 * pool, it sends tokens to the helper exactly as a buy would, measures what
 * arrived, has the helper send them back exactly as a sell would, and
 * measures what returned. Because it moves tokens from the real pool address,
 * it sees the tax the way a real v4 trade would meet it.
 *
 * Verified against a synthetic 5% token (5.00% each way) and real tokens (0%).
 *
 * Source, compiled with solc 0.8.26, optimizer 200 runs, EVM cancun:
 *
 * // SPDX-License-Identifier: MIT
 * pragma solidity 0.8.26;
 *
 * interface IERC20 {
 *     function balanceOf(address) external view returns (uint256);
 * }
 *
 * /// Measures a token's transfer tax, in an eth_call only — never deployed.
 * /// The same code is placed (by state override) at the pool address and at a
 * /// helper address. Running as the pool, `probe` sends `amount` to the helper
 * /// (a buy's path), measures what arrived, has the helper send it all back (a
 * /// sell's path), and measures what returned.
 * contract TaxProbe {
 *     function probe(address token, uint256 amount, address helper)
 *         external
 *         returns (uint256 received, uint256 returned)
 *     {
 *         IERC20 t = IERC20(token);
 *         uint256 h0 = t.balanceOf(helper);
 *         _transfer(token, helper, amount);
 *         received = t.balanceOf(helper) - h0;
 *
 *         uint256 p0 = t.balanceOf(address(this));
 *         TaxProbe(helper).forward(token, address(this), received);
 *         returned = t.balanceOf(address(this)) - p0;
 *     }
 *
 *     function forward(address token, address to, uint256 amount) external {
 *         _transfer(token, to, amount);
 *     }
 *
 *     function _transfer(address token, address to, uint256 amount) private {
 *         (bool ok, bytes memory data) =
 *             token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
 *         require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
 *     }
 * }
 */
const PROBE_CODE = '0x608060405234801561000f575f80fd5b5060043610610034575f3560e01c80633d4f287c14610038578063bd2530e514610064575b5f80fd5b61004b6100463660046103f3565b610079565b6040805192835260208301919091520160405180910390f35b61007761007236600461042c565b6102bc565b005b6040516370a0823160e01b81526001600160a01b0382811660048301525f918291869183918316906370a0823190602401602060405180830381865afa1580156100c5573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906100e99190610466565b90506100f68786886102cc565b6040516370a0823160e01b81526001600160a01b0386811660048301528291908416906370a0823190602401602060405180830381865afa15801561013d573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906101619190610466565b61016b919061047d565b6040516370a0823160e01b81523060048201529094505f906001600160a01b038416906370a0823190602401602060405180830381865afa1580156101b2573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906101d69190610466565b60405163bd2530e560e01b81526001600160a01b038a81166004830152306024830152604482018890529192509087169063bd2530e5906064015f604051808303815f87803b158015610227575f80fd5b505af1158015610239573d5f803e3d5ffd5b50506040516370a0823160e01b81523060048201528392506001600160a01b03861691506370a0823190602401602060405180830381865afa158015610281573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906102a59190610466565b6102af919061047d565b9350505050935093915050565b6102c78383836102cc565b505050565b604080516001600160a01b038481166024830152604480830185905283518084039091018152606490920183526020820180516001600160e01b031663a9059cbb60e01b17905291515f9283929087169161032791906104a2565b5f604051808303815f865af19150503d805f8114610360576040519150601f19603f3d011682016040523d82523d5f602084013e610365565b606091505b509150915081801561038f57508051158061038f57508080602001905181019061038f91906104b8565b6103d15760405162461bcd60e51b815260206004820152600f60248201526e1d1c985b9cd9995c8819985a5b1959608a1b604482015260640160405180910390fd5b5050505050565b80356001600160a01b03811681146103ee575f80fd5b919050565b5f805f60608486031215610405575f80fd5b61040e846103d8565b925060208401359150610423604085016103d8565b90509250925092565b5f805f6060848603121561043e575f80fd5b610447846103d8565b9250610455602085016103d8565b929592945050506040919091013590565b5f60208284031215610476575f80fd5b5051919050565b8181038181111561049c57634e487b7160e01b5f52601160045260245ffd5b92915050565b5f82518060208501845e5f920191825250919050565b5f602082840312156104c8575f80fd5b815180151581146104d7575f80fd5b939250505056fea26469706673582212209b32b0e4f1c167922a3bf28f7238d7ab995610898fc0406884589655c14743bb64736f6c634300081a0033' as Hex;

const PROBE_ABI = parseAbi([
  'function probe(address token, uint256 amount, address helper) returns (uint256 received, uint256 returned)',
]);

/** Any address with no code; the probe is installed there for the call only. */
const HELPER = '0x00000000000000000000000000000000000a4e10';
const TTL_MS = 10 * 60_000;
/**
 * A failed measurement is kept only briefly. Scanning 32 tokens, every
 * failure turned out to be a network blip — retried, all measured fine — so
 * "unknown" must not stick for the full window.
 */
const UNKNOWN_TTL_MS = 30_000;
/** Below this the "tax" is rounding, not a tax. */
const NOISE_PCT = 0.05;

export interface TransferTax {
  /** Percent lost when the pool sends the token to a buyer. */
  buyPct: number;
  /** Percent lost when a seller sends the token to the pool. */
  sellPct: number;
}

@Injectable()
export class TransferTaxService {
  private readonly log = new Logger(TransferTaxService.name);
  private readonly cache = new Map<string, { at: number; value: TransferTax | null }>();

  constructor(private readonly chain: ChainService) {}

  /**
   * The token's buy and sell tax, or null when it cannot be measured (the
   * pool holds too little, or the token refuses the simulated transfer).
   * Null means unknown, never "no tax". Never throws.
   */
  async measure(token: string, amount: bigint): Promise<TransferTax | null> {
    const key = token.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < (hit.value ? TTL_MS : UNKNOWN_TTL_MS)) return hit.value;

    // The trade's own size first; a much smaller one if the pool cannot cover it.
    let value: TransferTax | null = null;
    for (const size of [amount, amount / 1000n]) {
      if (size <= 0n) continue;
      value = await this.run(token, size);
      if (value) break;
    }
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private async run(token: string, amount: bigint): Promise<TransferTax | null> {
    const pool = this.chain.network.uniswapV4.POOL_MANAGER;
    try {
      const data = encodeFunctionData({
        abi: PROBE_ABI,
        functionName: 'probe',
        args: [getAddress(token), amount, HELPER],
      });
      const raw = (await this.chain.client.request({
        method: 'eth_call',
        params: [
          { to: pool, data, gas: '0x1c9c380' },
          'latest',
          { [pool]: { code: PROBE_CODE }, [HELPER]: { code: PROBE_CODE } },
        ],
      } as never)) as Hex;
      const [received, returned] = decodeFunctionResult({ abi: PROBE_ABI, functionName: 'probe', data: raw });
      return taxFrom(amount, received, returned);
    } catch (err) {
      this.log.debug(`tax probe failed for ${token}: ${(err as Error).message.split('\n')[0]}`);
      return null;
    }
  }
}

/** Percentages from the probe's three numbers, with rounding noise zeroed. */
export function taxFrom(sent: bigint, received: bigint, returned: bigint): TransferTax {
  const pct = (a: bigint, b: bigint) => {
    if (b <= 0n) return 0;
    const lost = Number(((b - a) * 1_000_000n) / b) / 10_000;
    return lost < NOISE_PCT ? 0 : Math.round(lost * 100) / 100;
  };
  return { buyPct: pct(received, sent), sellPct: received > 0n ? pct(returned, received) : 0 };
}
