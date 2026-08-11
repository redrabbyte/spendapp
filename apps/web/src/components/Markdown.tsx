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

function safeHref(url: string): string | null {
  const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return url; // relative, so it can only stay on this origin
  return ALLOWED.has(scheme) ? url : null;
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

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (heading) {
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
