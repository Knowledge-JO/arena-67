import { RichText } from '@/lib/rich-text';

/**
 * The agent's comment, inside the card it is about.
 *
 * A card is the answer; the agent's job is the one line of interpretation on
 * top — "you're down on U since entry". Loose text above the card read as a
 * second, competing answer, and when the model wrote its own table of the
 * card's numbers it came out as raw pipes. Tables are dropped here: the card
 * already is the table.
 */
export function CardNote({ text }: { text?: string }) {
  if (!text?.trim()) return null;
  return (
    <div className="flex gap-2.5 border-b border-border-base bg-surface/60 px-3.5 py-2.5 sm:px-4">
      <span
        aria-hidden="true"
        className="mt-0.5 h-5 w-5 shrink-0 rounded bg-accent/15 text-center text-[9px] font-semibold leading-5 text-accent"
      >
        67
      </span>
      <div className="min-w-0 text-[13px] leading-snug text-fg">
        <RichText text={text} dropTables />
      </div>
    </div>
  );
}
