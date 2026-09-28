/** Cards the model's tools draw; their figures go stale the moment they are shown. */
const CARD_LABELS: Record<string, string> = {
  portfolio: 'portfolio',
  token_report: 'token report',
  top_tokens: 'top tokens',
  new_tokens: 'new tokens',
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
 * Failures this prevents, all seen live:
 *
 * - Shown its own earlier reply containing a markdown table of the portfolio,
 *   the model answered the next "show my portfolio" from that table without
 *   calling the tool, so no card was drawn and the numbers were stale — and it
 *   wrote another table, since its history said that was the style. So tables
 *   and pipe-separated figure lines are removed from past replies.
 *
 * - Past replies used to end with a bracketed "[A portfolio card was shown…]"
 *   note. The model took that as its own style: it began writing the note
 *   itself instead of calling the tool, so the user saw the note and no card.
 *   Notes like that are now stripped from every past reply (older
 *   conversations still hold them), and which cards were shown is said in the
 *   system prompt instead — see `cardsShownNote` — where nothing is copied.
 */
export function historyForModel(turns: StoredTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return turns.map((t) => {
    if (t.role !== 'assistant') return { role: t.role, content: t.content };
    const content = stripFigures(stripCardNotes(t.content));
    return { role: t.role, content: content || '[No text.]' };
  });
}

/**
 * For the system prompt: which cards this conversation has already shown, and
 * that their figures are stale. Null when none were.
 */
export function cardsShownNote(turns: StoredTurn[]): string | null {
  const shown = [
    ...new Set(
      turns
        .filter((t) => t.role === 'assistant' && t.stepKind && CARD_LABELS[t.stepKind])
        .map((t) => CARD_LABELS[t.stepKind as string]),
    ),
  ];
  if (!shown.length) return null;
  return (
    `Earlier in this conversation the user was shown these cards: ${shown.join(', ')}. ` +
    'Their figures are out of date, and your earlier replies above do not contain them. ' +
    'Every new request — even one asked before — needs its tool called again: that is what ' +
    'draws the card the user expects. Never answer it from earlier messages.'
  );
}

/**
 * The bracketed card notes older replies carry, whether written by this code
 * or copied by the model into its own reply. Never meant for a person.
 */
const CARD_NOTE = /\[\s*An? [^\]\n]{0,60}?card was shown to the user[^\]]*\]/gi;

export function stripCardNotes(text: string): string {
  return text.replace(CARD_NOTE, '').replace(/\n{3,}/g, '\n\n').trim();
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
