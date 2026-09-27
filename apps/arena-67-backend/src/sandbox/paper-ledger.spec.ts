import { NATIVE_TOKEN } from '../chain/networks';
import {
  InsufficientPaperFunds,
  acquire,
  applyFill,
  assetKey,
  toFloat,
  type PaperPosition,
} from './paper-ledger';

const USDG = { asset: '0xusdg', symbol: 'USDG', decimals: 6 };
const ETH = { asset: NATIVE_TOKEN, symbol: 'ETH', decimals: 18 };
const TOK = { asset: '0xtok', symbol: 'TOK', decimals: 18 };
const usdg = (n: number) => BigInt(Math.round(n * 1e6));
const e18 = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

function book(...ps: PaperPosition[]) {
  return new Map(ps.map((p) => [p.asset, p]));
}
function deposit(asset: typeof USDG, units: bigint, usd: number) {
  return acquire(undefined, units, usd, asset);
}

describe('paper ledger', () => {
  it('a buy moves funding into the token at the trade value', () => {
    const r = applyFill(book(deposit(USDG, usdg(1000), 1000)), {
      side: 'buy', token: TOK, funding: USDG,
      amountIn: usdg(100), amountOut: e18(50), valueUsd: 100, fee: null,
    });
    const u = r.positions.get(USDG.asset)!;
    const t = r.positions.get(TOK.asset)!;
    expect(u.amount).toBe(usdg(900));
    expect(u.costUsd).toBeCloseTo(900);
    expect(t.amount).toBe(e18(50));
    expect(t.costUsd).toBeCloseTo(100);
    expect(r.realizedUsd).toBeCloseTo(0);
  });

  it('selling at twice the price realises the gain against average cost', () => {
    const bought = applyFill(book(deposit(USDG, usdg(1000), 1000)), {
      side: 'buy', token: TOK, funding: USDG,
      amountIn: usdg(100), amountOut: e18(50), valueUsd: 100, fee: null,
    }).positions;
    // Sell half at double the price: 25 TOK for $100.
    const r = applyFill(bought, {
      side: 'sell', token: TOK, funding: USDG,
      amountIn: e18(25), amountOut: usdg(100), valueUsd: 100, fee: null,
    });
    expect(r.realizedUsd).toBeCloseTo(50); // $100 proceeds − $50 of cost
    expect(r.positions.get(TOK.asset)!.costUsd).toBeCloseTo(50);
    expect(r.positions.get(USDG.asset)!.amount).toBe(usdg(1000));
  });

  it('selling everything leaves no stray cost behind', () => {
    const bought = applyFill(book(deposit(USDG, usdg(300), 300)), {
      side: 'buy', token: TOK, funding: USDG,
      amountIn: usdg(100), amountOut: e18(3), valueUsd: 100, fee: null,
    }).positions;
    const r = applyFill(bought, {
      side: 'sell', token: TOK, funding: USDG,
      amountIn: e18(3), amountOut: usdg(40), valueUsd: 40, fee: null,
    });
    expect(r.positions.get(TOK.asset)!.amount).toBe(0n);
    expect(r.positions.get(TOK.asset)!.costUsd).toBe(0);
    expect(r.realizedUsd).toBeCloseTo(-60);
  });

  it('charges the fee first and books it as a loss', () => {
    const start = book(deposit(USDG, usdg(100), 100), deposit(ETH, e18(1), 3000));
    const r = applyFill(start, {
      side: 'buy', token: TOK, funding: USDG,
      amountIn: usdg(10), amountOut: e18(1), valueUsd: 10,
      fee: { ...ETH, units: e18(0.0001), usd: 0.3 },
    });
    const eth = r.positions.get(ETH.asset)!;
    expect(eth.amount).toBe(e18(1) - e18(0.0001));
    expect(eth.realizedUsd).toBeCloseTo(-0.3);
  });

  it('refuses a trade it cannot pay for, and leaves the book untouched', () => {
    const start = book(deposit(USDG, usdg(5), 5));
    expect(() =>
      applyFill(start, {
        side: 'buy', token: TOK, funding: USDG,
        amountIn: usdg(10), amountOut: e18(1), valueUsd: 10, fee: null,
      }),
    ).toThrow(InsufficientPaperFunds);
    expect(start.get(USDG.asset)!.amount).toBe(usdg(5));
  });

  it('refuses when the trade fits but the fee on the same asset does not', () => {
    const start = book(deposit(ETH, e18(1), 3000));
    expect(() =>
      applyFill(start, {
        side: 'buy', token: TOK, funding: ETH,
        amountIn: e18(1), amountOut: e18(100), valueUsd: 3000,
        fee: { ...ETH, units: e18(0.001), usd: 3 },
      }),
    ).toThrow(InsufficientPaperFunds);
  });

  it('realised plus unrealised always equals value minus deposits', () => {
    // Deposit, then trade through changing prices, then value at new prices.
    let pos = book(deposit(USDG, usdg(1000), 1000), deposit(ETH, e18(0.5), 1500));
    const deposits = 2500;
    pos = applyFill(pos, { side: 'buy', token: TOK, funding: USDG, amountIn: usdg(400), amountOut: e18(200), valueUsd: 400, fee: { ...ETH, units: e18(0.0002), usd: 0.6 } }).positions;
    // ETH now $3200; spend 0.25 ETH on TOK at $2.40.
    pos = applyFill(pos, { side: 'buy', token: TOK, funding: ETH, amountIn: e18(0.25), amountOut: e18(333.333333), valueUsd: 800, fee: { ...ETH, units: e18(0.0002), usd: 0.64 } }).positions;
    // TOK at $3: sell 150 for 450 USDG.
    pos = applyFill(pos, { side: 'sell', token: TOK, funding: USDG, amountIn: e18(150), amountOut: usdg(450), valueUsd: 450, fee: { ...ETH, units: e18(0.0002), usd: 0.64 } }).positions;

    const price: Record<string, number> = { [USDG.asset]: 1, [ETH.asset]: 3300, [TOK.asset]: 2.5 };
    let equity = 0, realized = 0, unrealized = 0;
    for (const p of pos.values()) {
      const value = toFloat(p.amount, p.decimals) * price[p.asset];
      equity += value;
      realized += p.realizedUsd;
      unrealized += value - p.costUsd;
    }
    expect(realized + unrealized).toBeCloseTo(equity - deposits, 6);
  });

  it('treats ETH and WETH as one paper balance', () => {
    const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
    expect(assetKey(weth, weth)).toBe(NATIVE_TOKEN);
    expect(assetKey(NATIVE_TOKEN, weth)).toBe(NATIVE_TOKEN);
    expect(assetKey('0xABC', weth)).toBe('0xabc');
  });
});
