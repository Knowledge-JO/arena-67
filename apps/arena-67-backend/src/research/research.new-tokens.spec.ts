// Only the service under test is real. Its collaborators are stubbed below,
// and their modules pull in ESM-only packages Jest cannot load.
jest.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined, CronExpression: {} }));
jest.mock('../chain/pool-index.service', () => ({ PoolIndexService: class {} }));
jest.mock('../market/market.service', () => ({ MarketService: class {} }));
jest.mock('./volume.service', () => ({ VolumeService: class {}, RANKING_MAX: 50 }));

import { ResearchService } from './research.service';
import type { TokenVolume } from '../market/market.types';

const HOUR = 3_600_000;
const none = { m5: null, h1: null, h6: null, h24: null };

function token(address: string, hoursOld: number | null, liquidityUsd: number | null): TokenVolume {
  return {
    address: address as `0x${string}`,
    symbol: address.slice(2, 5).toUpperCase(),
    name: address,
    imageUrl: null,
    priceUsd: 1,
    marketCap: 10_000,
    liquidityUsd,
    volumeUsd: { ...none, h24: 5_000 },
    priceChange24h: null,
    priceChange: { ...none, h24: 12 },
    firstPoolAt: hoursOld == null ? null : Date.now() - hoursOld * HOUR,
  };
}

function service(volumes: TokenVolume[]) {
  const index = { recentTokens: jest.fn(() => volumes.map((v) => v.address)), stats: () => ({ ready: false }) };
  const market = { volumes: jest.fn(async () => volumes) };
  const svc = new ResearchService(index as never, market as never, {} as never);
  return { svc, market };
}

describe('ResearchService.newTokens', () => {
  it('keeps only recent launches with liquidity, newest first', async () => {
    const { svc } = service([
      token('0xaaa1', 3, 5_000), // new, liquid
      token('0xbbb2', 1, 2_000), // newer, liquid
      token('0xccc3', 0.5, 200), // too little liquidity
      token('0xddd4', 24 * 10, 90_000), // old token with a fresh pool
      token('0xeee5', null, 50_000), // launch time unknown
      token('0xfff6', 2, null), // no liquidity figure
    ]);
    const list = await svc.newTokens(12);
    expect(list.view).toBe('new');
    expect(list.tokens.map((t) => t.address)).toEqual(['0xbbb2', '0xaaa1']);
    expect(list.total).toBe(2);
    expect(list.tokens[0]).toMatchObject({ volumeUsd: 5_000, priceChangePct: 12, liquidityUsd: 2_000 });
  });

  it('pages from one cached list', async () => {
    const many = Array.from({ length: 20 }, (_, i) => token(`0x${String(i).padStart(4, '0')}`, i / 10, 5_000));
    const { svc, market } = service(many);
    expect((await svc.newTokens(12)).tokens).toHaveLength(12);
    const more = await svc.newTokens(24);
    expect(more.tokens).toHaveLength(20);
    expect(more.total).toBe(20);
    expect(market.volumes).toHaveBeenCalledTimes(1);
  });
});
