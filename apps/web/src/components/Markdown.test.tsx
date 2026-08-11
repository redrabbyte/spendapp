import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

/**
 * The privacy policy is a file edited on the server, outside review, and it is
 * rendered on the login page — so what this component refuses matters as much
 * as what it draws.
 */
const html = (text: string): string => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
  it('renders the marks a policy uses', () => {
    const out = html('## Storage\n\nWe keep **little**, in `localStorage`.\n\n- a cookie\n- a cache');
    expect(out).toContain('<p class="text-sm font-semibold text-slate-900 dark:text-slate-100">Storage</p>');
    expect(out).toContain('<strong>little</strong>');
    expect(out).toContain('<code');
    expect(out).toContain('<li>a cookie</li>');
    expect(out).toContain('<li>a cache</li>');
  });

  it('joins wrapped lines into one paragraph', () => {
    // Policies are hard-wrapped in the file; the reader should not see that.
    expect(html('one line\nand its continuation')).toContain('one line and its continuation');
  });

  it('links out safely', () => {
    const out = html('Read [the rules](https://example.com/x).');
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('rel="noreferrer noopener"');
  });

  it('refuses a javascript: link but keeps its words', () => {
    const out = html('[click me](javascript:alert(1))');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('<a');
    // Dropping the text would hide a sentence from somebody being asked to
    // agree to it, so the words stay and only the link is taken away.
    expect(out).toContain('click me');
  });

  it('escapes HTML in the source rather than rendering it', () => {
    // The whole reason this emits React elements and not an HTML string.
    const out = html('Hello <img src=x onerror=alert(1)> there');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('survives an empty document', () => {
    expect(html('')).toBe('<div class="flex flex-col gap-2"></div>');
  });
});
