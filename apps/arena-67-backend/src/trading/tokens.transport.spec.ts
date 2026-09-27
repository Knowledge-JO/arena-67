jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@nestjs/schedule', () => ({ Cron: () => () => undefined, CronExpression: {}, Interval: () => () => undefined }));

import { isTransportError } from './tokens.service';

describe('isTransportError', () => {
  it('sees a network failure through viem’s wrapping', () => {
    const http = Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError' });
    const call = Object.assign(new Error('call failed'), { name: 'CallExecutionError', cause: http });
    const wrapped = Object.assign(new Error('contract call failed'), { name: 'ContractFunctionExecutionError', cause: call });
    expect(isTransportError(wrapped)).toBe(true);
  });

  it('treats a revert as an answer, not an outage', () => {
    const revert = Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' });
    const wrapped = Object.assign(new Error('contract call failed'), { name: 'ContractFunctionExecutionError', cause: revert });
    expect(isTransportError(wrapped)).toBe(false);
  });
});

import { readable } from './trading.service';

describe('readable', () => {
  it('cuts to eight significant digits without rounding up', () => {
    expect(readable(119_062730975421234567n, 18)).toBe('119.06273');
    expect(readable(115_490849999999999999n, 18)).toBe('115.49084');
  });
  it('keeps small amounts meaningful', () => {
    expect(readable(12_345_678_912n, 18)).toBe('0.000000012345678');
    expect(readable(42_170_855n, 6)).toBe('42.170855');
  });
  it('leaves whole numbers alone', () => {
    expect(readable(100_000_000n, 6)).toBe('100');
    expect(readable(123_456_789_000_000_000_000_000_000n, 18)).toBe('123456789');
  });
});

import { poolFeeText } from './trading.service';

describe('poolFeeText', () => {
  it('shows a fixed fee as a percentage', () => {
    expect(poolFeeText(3000)).toBe('0.3%');
    expect(poolFeeText(2300)).toBe('0.23%');
  });
  it('never shows the dynamic-fee flag as a fee', () => {
    // 0x800000 divided as a fee was "838.8608%".
    expect(poolFeeText(0x800000)).not.toMatch(/%/);
    expect(poolFeeText(0x800000)).toMatch(/included in the price/);
  });
});

import { wholeIfAll } from './trading.service';

describe('wholeIfAll', () => {
  const held = 8405_595584783470486026n;
  it('sells the whole balance when the asked amount lost digits as a JS number', () => {
    expect(wholeIfAll(8405_595584783470000000n, held)).toBe(held);
  });
  it('also when rounding pushed it just over', () => {
    expect(wholeIfAll(held + 10n, held)).toBe(held);
  });
  it('leaves a genuine partial sell alone', () => {
    expect(wholeIfAll(held / 2n, held)).toBe(held / 2n);
  });
});

import { percentOf } from './trading.service';

describe('percentOf', () => {
  const held = 11_789_473_856760000000000001n;
  it('is the whole balance at 100%', () => expect(percentOf(held, 100)).toBe(held));
  it('is exact for common shares', () => {
    expect(percentOf(10_000n, 25)).toBe(2_500n);
    expect(percentOf(10_000n, 12.5)).toBe(1_250n);
  });
});
