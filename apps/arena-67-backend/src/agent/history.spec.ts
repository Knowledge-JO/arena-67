import { cardsShownNote, historyForModel, stripCardNotes, stripFigures } from './history';

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

  it('keeps card notes out of past replies, where the model would copy them', () => {
    const [, reply] = historyForModel([
      { role: 'user', content: 'Show my portfolio' },
      { role: 'assistant', content: OLD_REPLY, stepKind: 'portfolio' },
    ]);
    expect(reply.content).not.toMatch(/card was shown/);
    expect(reply.content).not.toMatch(/\$3,463/);
  });

  it('says which cards were shown, and that they are stale, for the system prompt', () => {
    const note = cardsShownNote([
      { role: 'user', content: 'Show my portfolio' },
      { role: 'assistant', content: 'Here you go.', stepKind: 'portfolio' },
      { role: 'user', content: 'Sell NVDA' },
      { role: 'assistant', content: 'Pick a pool.', stepKind: 'token_detail' },
      { role: 'assistant', content: 'Again.', stepKind: 'portfolio' },
    ]);
    expect(note).toMatch(/portfolio, token page\./);
    expect(note).toMatch(/out of date/);
    expect(note).toMatch(/tool called again/);
    expect(cardsShownNote([{ role: 'assistant', content: 'Hi' }])).toBeNull();
  });

  it('strips notes the model copied into its own replies', () => {
    // Verbatim from the live transcript: the note, twice, and no card.
    const copied =
      "You're down –$4.21 (–0.1%) overall. Your holdings are ETH, USDG, MOBE, and NVDA.\n\n" +
      '[A portfolio card was shown to the user here, with figures from that moment. They are out of date now: ' +
      'call the tool again for anything current, and never repeat these figures.]\n\n' +
      '[A portfolio card was shown to the user here, with figures from that moment. They are out of date now: ' +
      'call the tool again for anything current, and never repeat these figures.]';
    expect(stripCardNotes(copied)).toBe("You're down –$4.21 (–0.1%) overall. Your holdings are ETH, USDG, MOBE, and NVDA.");
    const [, reply] = historyForModel([
      { role: 'user', content: 'Sell NVDA' },
      {
        role: 'assistant',
        content:
          'NVDA trades on 2 pools. Pick your venue.\n\n[A token page card was shown to the user here, with figures ' +
          'from that moment. They are out of date now: call the tool again for anything current, and never repeat these figures.]',
        stepKind: null,
      },
    ]);
    expect(reply.content).toBe('NVDA trades on 2 pools. Pick your venue.');
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
