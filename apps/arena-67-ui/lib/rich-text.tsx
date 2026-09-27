import { Fragment, type ReactNode } from 'react';
import { shortAddress } from './utils';

/**
 * The little markdown the model actually writes — **bold**, `code`, bullet
 * and numbered lists, paragraphs — turned into React elements.
 *
 * Deliberately not a markdown library. Model output is untrusted text, and
 * building elements by hand means nothing it writes can become HTML: there is
 * no `dangerouslySetInnerHTML` and no link or image syntax. Anything not
 * recognised is shown as written.
 *
 * Full addresses are shortened to `0x0c17…6Cbe`, with the whole address on
 * hover. A 42-character hex string in the middle of a sentence is noise to
 * most readers; the cards carry the copyable version.
 */
export function RichText({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        const bullets = lines.every((l) => /^\s*[-*•]\s+/.test(l));
        const numbered = lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
        if (bullets || numbered) {
          const List = numbered ? 'ol' : 'ul';
          return (
            <List
              key={i}
              className={
                numbered
                  ? 'my-1.5 list-decimal space-y-1 pl-5'
                  : 'my-1.5 list-disc space-y-1 pl-5 marker:text-fg-subtle'
              }
            >
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''))}</li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} className={i > 0 ? 'mt-2.5' : undefined}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l.replace(/^#{1,6}\s+/, ''))}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|0x[a-fA-F0-9]{40}\b)/g;

function inline(line: string): ReactNode[] {
  return line.split(TOKEN).map((part, i) => {
    if (!part) return null;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={i} className="font-semibold">
          {inline(part.slice(2, -2))}
        </strong>
      );
    }
    if (/^0x[a-fA-F0-9]{40}$/.test(part)) {
      return (
        <code key={i} title={part} className="rounded bg-border-base px-1 py-px font-mono text-[0.85em] text-fg-muted">
          {shortAddress(part)}
        </code>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={i} className="rounded bg-border-base px-1 py-px font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}
