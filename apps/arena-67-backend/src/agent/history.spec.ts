import { historyForModel, stripFigures } from './history';

/** Verbatim from the live transcript that drew no card. */
const OLD_REPLY = `Portfolio (Sandbox)

| Asset | Balance | Price | Value | P&L |
|-------|---------|-------|-------|-----|
| U | 11.8M | $0.000209 | $2,463 | −$224 (−8.3%) |
| USDG | 1,000 | $1.00 | $1,000 | — |

Total: $3,463 | Net deposits: $3,687 | Total return: −$224 (−6.1%)

Still holding U; no trades since last check.`;

describe('historyForModel', () => {
  it('removes the table and figure lines the model would copy or reuse', () => {
    const out = stripFigures(OLD_REPLY);
    expect(out).not.toMatch(/\|/);
    expect(out).not.toMatch(/\$2,463/);
    expect(out).toContain('Still holding U');
  });

  it('marks a card turn as stale so the tool gets called again', () => {
    const [, reply] = historyForModel([
      { role: 'user', content: 'Show my portfolio' },
      { role: 'assistant', content: OLD_REPLY, stepKind: 'portfolio' },
    ]);
    expect(reply.content).toMatch(/portfolio card was shown/);
    expect(reply.content).toMatch(/out of date/);
    expect(reply.content).not.toMatch(/\$3,463/);
  });

  it('leaves user messages and plain replies alone', () => {
    const turns = historyForModel([
      { role: 'user', content: 'a | b | c' },
      { role: 'assistant', content: 'AI is a memecoin on Robinhood Chain.' },
    ]);
    expect(turns[0].content).toBe('a | b | c');
    expect(turns[1].content).toBe('AI is a memecoin on Robinhood Chain.');
  });
});
