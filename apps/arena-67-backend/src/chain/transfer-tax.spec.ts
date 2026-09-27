jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined, CronExpression: {}, Interval: () => () => undefined }));
import { taxFrom } from './transfer-tax.service';
import { afterTax } from '../trading/trading.service';

describe('transfer tax', () => {
  it('reads buy and sell tax from what arrived and what came back', () => {
    // 1000 sent, 950 arrived (5%), 902.5 returned (5% of 950).
    expect(taxFrom(1000_000000n, 950_000000n, 902_500000n)).toEqual({ buyPct: 5, sellPct: 5 });
  });
  it('treats rounding dust as no tax', () => {
    expect(taxFrom(1_000_000_000n, 999_999_999n, 999_999_999n)).toEqual({ buyPct: 0, sellPct: 0 });
  });
  it('takes the percentage off in base units', () => {
    expect(afterTax(1_000_000n, 5)).toBe(950_000n);
    expect(afterTax(1_000_000n, 0)).toBe(1_000_000n);
    expect(afterTax(1_000_000n, 12.5)).toBe(875_000n);
  });
});
