import { asksForPortfolio, needsTool } from './intent';

describe('intent', () => {
  it.each(['show my portfolio', 'Show me my portfolio', 'what do I hold?', 'my balance', 'how am I doing'])(
    'reads "%s" as a portfolio request',
    (m) => {
      expect(asksForPortfolio(m)).toBe(true);
      expect(needsTool(m)).toBe(true);
    },
  );

  it.each(['Sell NVDA', 'buy $50 of DOLL', 'sell 100%', 'what just launched?', 'top tokens by volume', 'who holds 0x2e8c3116aE8A6F2b4bA36Ba7a5bE39A8D4F9E001'])(
    'reads "%s" as needing live data',
    (m) => {
      expect(needsTool(m)).toBe(true);
      expect(asksForPortfolio(m)).toBe(false);
    },
  );

  it.each(['thanks!', 'what is a memecoin?', 'hello'])('lets "%s" be answered without a tool', (m) => {
    expect(needsTool(m)).toBe(false);
  });
});
