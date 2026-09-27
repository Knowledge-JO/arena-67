
import { signalsFor, type TokenReport } from './report.signals';
import type { HoldersBlock } from '../holders/holders.service';

const NOW = Date.UTC(2026, 8, 27);

function report(over: {
  market?: Partial<NonNullable<TokenReport['market']>> | null;
  holders?: Partial<HoldersBlock>;
  owner?: string | null;
  links?: boolean;
}): TokenReport {
  const market =
    over.market === null
      ? null
      : {
          priceUsd: 1,
          marketCap: 1_000_000,
          fdv: 1_000_000,
          liquidityUsd: 200_000,
          volumeUsd: { m5: null, h1: null, h6: null, h24: 50_000 },
          priceChange: { m5: null, h1: null, h6: null, h24: 5 },
          buys: { h1: null, h24: 100 },
          sells: { h1: null, h24: 100 },
          firstPoolAt: NOW - 30 * 24 * 3_600_000,
          pairCount: 1,
          dexes: ['uniswap'],
          ...over.market,
        };
  return {
    kind: 'token_report',
    token: {
      address: '0x1',
      symbol: 'T',
      name: 'Token',
      decimals: 18,
      totalSupply: '1000',
      imageUrl: null,
      websites: over.links === false ? [] : [{ url: 'https://x', label: 'Website' }],
      socials: [],
      owner: over.owner ?? null,
    },
    market,
    pools: [],
    holders: {
      status: 'ready',
      progress: 100,
      error: null,
      holderCount: 10,
      top: [],
      breakdown: { top10WalletsPercent: 12, poolsPercent: 30, burnedPercent: 0, contractsPercent: 0, basis: 100 },
      drift: null,
      asOfBlock: '1',
      ...over.holders,
    },
    signals: [],
    explorer: 'https://x',
    asOf: new Date(NOW).toISOString(),
  };
}

const texts = (r: TokenReport) => signalsFor(r, NOW).map((s) => `${s.tone}: ${s.text}`);

describe('report signals', () => {
  it('says a quiet, spread-out token is spread out, and nothing alarming', () => {
    const s = signalsFor(report({}), NOW);
    expect(s.filter((x) => x.tone === 'caution')).toEqual([]);
    expect(s.some((x) => x.tone === 'good' && x.text.includes('Spread out'))).toBe(true);
  });

  it('flags concentration by wallets, not by pool balances', () => {
    // 30% in pools is not a whale; 60% across the top ten wallets is.
    const t = texts(report({ holders: { breakdown: { top10WalletsPercent: 60, poolsPercent: 30, burnedPercent: 0, contractsPercent: 0, basis: 100 } } }));
    expect(t.some((x) => x.startsWith('caution: Concentrated') && x.includes('60%'))).toBe(true);
  });

  it('warns about thin liquidity and very new tokens', () => {
    const t = texts(report({ market: { liquidityUsd: 4_000, firstPoolAt: NOW - 3 * 3_600_000 } }));
    expect(t.some((x) => x.includes('Thin liquidity ($4.0K)'))).toBe(true);
    expect(t.some((x) => x.includes('about 3 hours ago'))).toBe(true);
  });

  it('describes one-sided trading in words that survive zero on one side', () => {
    const t = texts(report({ market: { buys: { h1: null, h24: 0 }, sells: { h1: null, h24: 25 } } }));
    expect(t).toContain('caution: More selling than buying today: 25 sells and no buys.');
  });

  it('says holders are still being counted instead of guessing', () => {
    const t = texts(report({ holders: { status: 'indexing', breakdown: null } }));
    expect(t.some((x) => x.includes('Still counting holders'))).toBe(true);
    expect(t.some((x) => x.includes('wallets hold'))).toBe(false);
  });

  it('distinguishes an owned contract from a renounced one, and says nothing when there is no owner()', () => {
    expect(texts(report({ owner: '0xabc' })).some((x) => x.includes('has an owner'))).toBe(true);
    expect(texts(report({ owner: '0x0000000000000000000000000000000000000000' })).some((x) => x.includes('given up'))).toBe(true);
    expect(texts(report({ owner: null })).some((x) => x.toLowerCase().includes('owner'))).toBe(false);
  });

  it('says when no exchange lists the token rather than implying zero', () => {
    const t = texts(report({ market: null, links: false }));
    expect(t.some((x) => x.includes('No exchange lists this token'))).toBe(true);
    // The missing-links note only makes sense for a listed token.
    expect(t.some((x) => x.includes('No website'))).toBe(false);
  });

  it('does not call a token spread out when its supply has not left the pool', () => {
    const t = texts(report({ holders: { breakdown: { top10WalletsPercent: 0.01, poolsPercent: 99.9, burnedPercent: 0, contractsPercent: 0, basis: 3 } } }));
    expect(t.some((x) => x.includes('Spread out'))).toBe(false);
    expect(t.some((x) => x.includes('still in the liquidity pool'))).toBe(true);
  });

  it('flags drift', () => {
    const t = texts(report({ holders: { drift: { indexedPercentOfSupply: 91 } } }));
    expect(t.some((x) => x.includes('approximate'))).toBe(true);
  });
});
