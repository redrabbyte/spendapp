import type { ReactNode } from 'react';

/**
 * The small slice of markdown a privacy policy actually uses: headings,
 * paragraphs, bullet lists, bold, inline code and links.
 *
 * Written out rather than pulled in, for the same reason `i18n/index.ts` is:
 * a general parser is a large dependency for one document, and this document's
 * vocabulary is fixed.
 *
 * It emits React elements, never HTML — which is what makes rendering the
 * policy safe at all. The file is edited on the server, outside review, so
 * `dangerouslySetInnerHTML` would hand whoever edits it a script tag on the
 * login page. React escapes every text node, so the only thing that could
 * still carry code is a link's own href, and `safeHref` refuses any scheme but
 * http, https and mailto.
 */

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

/**
 * `javascript:` and `data:` are the reason this is not just `href={url}`.
 *
 * The scheme is read off the string rather than resolved through `new URL`
 * against `window.location`: this has to give the same answer everywhere, and
 * a version that leaned on `window` turned every link into plain text the
 * moment it ran outside a browser — silently, since a failed parse is
 * indistinguishable from a refused one.
 */
const SCHEME = /^\s*([a-z][a-z0-9+.-]*):/i;
const ALLOWED = new Set(['http', 'https', 'mailto']);
/** Tab, newline and return: dropped by the browser wherever they appear. */
const STRIPPED = /[\t\n\r]/g;
/** Leading controls and spaces: trimmed by the browser before the scheme. */
const LEADING = /^[\u0000-\u0020]+/;

function safeHref(url: string): string | null {
  // `java\tscript:` reaches the browser as `javascript:` — the tab breaks the
  // scheme match here, the value falls through as "relative", and the browser
  // puts it back together. Same for a leading control character. So the check
  // has to run on the string the browser will act on, not the one written down.
  const cleaned = url.replace(STRIPPED, '').replace(LEADING, '');
  const scheme = SCHEME.exec(cleaned)?.[1]?.toLowerCase();
  // A colon with no scheme in front of it is nothing this renders; refusing is
  // safer than guessing which half the browser will believe.
  if (!scheme) return cleaned.includes(':') ? null : cleaned;
  return ALLOWED.has(scheme) ? cleaned : null;
}

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={key} className="rounded bg-slate-200 px-1 py-0.5 text-[0.95em] dark:bg-slate-700">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const href = safeHref(link[2]!);
      // A refused scheme still shows its words — dropping the text would hide
      // a sentence from someone being asked to agree to it.
      if (!href) return link[1];
      return (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline decoration-slate-400 underline-offset-2"
        >
          {link[1]}
        </a>
      );
    }
    // A plain run goes back as a string: React takes those in an array as-is,
    // and wrapping each one in a <span> would litter the policy with markup.
    return part;
  });
}

/**
 * A pipe table is a header row, a row of dashes, then body rows. The dashes
 * are what distinguishes it from a paragraph that happens to contain a `|`,
 * so a row only starts a table when the line under it is one.
 */
const hasPipe = (line: string): boolean => line.includes('|');

/** `| a | b |` and `a | b` both give ['a', 'b']. */
const cells = (line: string): string[] =>
  line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/**
 * Every cell is dashes, with optional alignment colons. Checked cell by cell
 * rather than with one regex over the whole line — the regex version wanted at
 * least two columns and quietly failed to see `|---|`.
 */
const isDelimiter = (line: string): boolean => {
  if (!hasPipe(line)) return false;
  const parts = cells(line);
  return parts.length > 0 && parts.every((c) => /^:?-+:?$/.test(c));
};

type Align = 'left' | 'center' | 'right';
const alignments = (line: string): Align[] =>
  cells(line).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    return left && right ? 'center' : right ? 'right' : 'left';
  });

const alignClass: Record<Align, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/** Blank lines separate blocks; a run of `- ` lines is one list. */
export function Markdown({ text }: { text: string }): ReactNode {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const key = `p-${blocks.length}`;
    blocks.push(<p key={key}>{inline(paragraph.join(' '), key)}</p>);
    paragraph = [];
  };
  const flushBullets = () => {
    if (!bullets.length) return;
    const key = `ul-${blocks.length}`;
    blocks.push(
      <ul key={key} className="list-disc pl-5">
        {bullets.map((b, i) => (
          <li key={i}>{inline(b, `${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  const flush = () => {
    flushParagraph();
    flushBullets();
  };

  // Indexed rather than for-of: a table is only a table if the *next* line is
  // its row of dashes, so this has to be able to look ahead.
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);

    if (hasPipe(line) && isDelimiter(lines[i + 1] ?? '')) {
      flush();
      const header = cells(line);
      const align = alignments(lines[i + 1]!);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && hasPipe(lines[i]!) && lines[i]!.trim() !== '') {
        // Pad or trim to the header's width: a row with the wrong number of
        // cells is a typo in the policy, not a reason to drop the table.
        const row = cells(lines[i]!);
        body.push(Array.from({ length: header.length }, (_, c) => row[c] ?? ''));
        i++;
      }
      i--; // the loop's own i++ takes us past the last row
      const key = `t-${blocks.length}`;
      const cell = 'border-b border-slate-300 px-2 py-1 align-top dark:border-slate-600';
      blocks.push(
        // Its own scroller: a policy read on a phone must not make the whole
        // page slide sideways.
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {header.map((h, c) => (
                  <th key={c} className={`${cell} font-semibold ${alignClass[align[c] ?? 'left']}`}>
                    {inline(h, `${key}-h-${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                <tr key={r}>
                  {row.map((c, ci) => (
                    <td key={ci} className={`${cell} ${alignClass[align[ci] ?? 'left']}`}>
                      {inline(c, `${key}-${r}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (heading) {
      flush();
      const key = `h-${blocks.length}`;
      // One step down: the page around this already owns the h1.
      const size = ['text-base', 'text-sm', 'text-sm', 'text-sm'][heading[1]!.length - 1];
      blocks.push(
        <p key={key} className={`${size} font-semibold text-slate-900 dark:text-slate-100`}>
          {inline(heading[2]!, key)}
        </p>,
      );
    } else if (bullet) {
      flushParagraph();
      bullets.push(bullet[1]!);
    } else if (line.trim() === '') {
      flush();
    } else {
      flushBullets();
      paragraph.push(line.trim());
    }
  }
  flush();

  return <div className="flex flex-col gap-2">{blocks}</div>;
}
