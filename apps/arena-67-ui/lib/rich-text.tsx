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
export function RichText({ text, dropTables = false }: { text: string; dropTables?: boolean }) {
  let source = text.replace(/\r\n/g, '\n');
  if (dropTables) {
    // Markdown table rows and their |---| separators. Used where a card is
    // already showing the same data as a proper table.
    source = source
      .split('\n')
      .filter(
        (l) =>
          // Table rows and separators.
          !/^\s*\|.*\|\s*$/.test(l) &&
          // Pipe-separated figure lines ("Total: $x | Deposits: $y | ...").
          (l.match(/\|/g) ?? []).length < 2 &&
          // A heading on its own ("## Portfolio", "**Portfolio (Sandbox)**").
          !/^\s*(#{1,6}\s+.+|\*\*[^*]+\*\*:?)\s*$/.test(l),
      )
      .join('\n');
  }
  const blocks = source.trim().split(/\n{2,}/).filter((b) => b.trim());
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        const table = asTable(lines);
        if (table) {
          return (
            <div key={i} className="my-2 max-w-full overflow-x-auto rounded-lg border border-border-base">
              <table className="w-full text-left text-[12px] tabular-nums">
                <thead className="bg-surface text-fg-subtle">
                  <tr>
                    {table.head.map((h, j) => (
                      <th key={j} className="whitespace-nowrap px-3 py-1.5 font-medium">
                        {inline(h)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-base/60">
                  {table.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, k) => (
                        <td key={k} className="whitespace-nowrap px-3 py-1.5">
                          {inline(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
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

/**
 * A markdown table — header row, |---| separator, body rows — as cells. Only
 * reached for replies saved before the model stopped writing tables; shown as
 * a real table so it is readable instead of a wall of pipes.
 */
function asTable(lines: string[]): { head: string[]; rows: string[][] } | null {
  const rows = lines.filter((l) => l.trim());
  if (rows.length < 2 || !rows.every((l) => /^\s*\|.*\|\s*$/.test(l))) return null;
  if (!/^\s*\|[\s:|-]+\|\s*$/.test(rows[1])) return null;
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  return { head: cells(rows[0]), rows: rows.slice(2).map(cells) };
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
