/** Cards the model's tools draw; their figures go stale the moment they are shown. */
const CARD_LABELS: Record<string, string> = {
  portfolio: 'portfolio',
  token_report: 'token report',
  top_tokens: 'top tokens',
  holder_overlap: 'common holders',
  wallet_holdings: 'wallet holdings',
  token_choices: 'token search results',
  token_detail: 'token page',
  confirm: 'trade quote',
  executed: 'trade result',
};

export interface StoredTurn {
  role: 'user' | 'assistant';
  content: string;
  /** The kind of card this turn drew, if any. */
  stepKind?: string | null;
}

/**
 * Past turns as the model should see them.
 *
 * Two failures this prevents, both seen live. Shown its own earlier reply
 * containing a markdown table of the portfolio, the model (a) answered the
 * next "show my portfolio" from that table — "no change since last check" —
 * without calling the tool, so no card was drawn and the numbers were stale;
 * and (b) wrote another table, since its history said that was the style.
 *
 * So tables and pipe-separated figure lines are removed from past replies,
 * and a turn that drew a card is marked as such, with a reminder that its
 * figures are out of date.
 */
export function historyForModel(turns: StoredTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return turns.map((t) => {
    if (t.role !== 'assistant') return { role: t.role, content: t.content };
    const cleaned = stripFigures(t.content);
    const label = t.stepKind ? CARD_LABELS[t.stepKind] : undefined;
    const marker = label
      ? `[A ${label} card was shown to the user here, with figures from that moment. They are out of date now: ` +
        'call the tool again for anything current, and never repeat these figures.]'
      : '';
    const content = [cleaned, marker].filter(Boolean).join('\n\n');
    return { role: t.role, content: content || '[No text.]' };
  });
}

/** Removes markdown tables, pipe-separated figure lines, and bare headings. */
export function stripFigures(text: string): string {
  return text
    .split('\n')
    .filter(
      (l) =>
        !/^\s*\|.*\|\s*$/.test(l) &&
        (l.match(/\|/g) ?? []).length < 2 &&
        !/^\s*(#{1,6}\s+.+|\*\*[^*]+\*\*:?)\s*$/.test(l),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
