import { describe, expect, it } from 'vitest';
import { safeNavTarget } from './swNav';

const SCOPE = 'https://app.example/';

describe('where a notification tap may go', () => {
  it('follows an ordinary in-app path', () => {
    expect(safeNavTarget('/g/123', SCOPE)).toEqual({ path: '/g/123', href: 'https://app.example/g/123' });
  });

  it('refuses an absolute off-origin URL', () => {
    expect(safeNavTarget('https://evil.example/login', SCOPE).href).toBe('https://app.example/');
  });

  it('refuses a protocol-relative URL', () => {
    // The one that mattered: it starts with a slash, so a startsWith('/')
    // check reads it as local, and the browser reads it as another origin.
    expect(safeNavTarget('//evil.example/login', SCOPE).href).toBe('https://app.example/');
    expect(safeNavTarget('//evil.example/login', SCOPE).path).toBe('/');
  });

  it('refuses other schemes', () => {
    expect(safeNavTarget('javascript:alert(1)', SCOPE).href).toBe('https://app.example/');
    expect(safeNavTarget('data:text/html,<script>', SCOPE).href).toBe('https://app.example/');
  });

  it('falls home on a missing or unparseable url', () => {
    expect(safeNavTarget(undefined, SCOPE).href).toBe('https://app.example/');
    expect(safeNavTarget('http://[', SCOPE).href).toBe('https://app.example/');
  });

  it('keeps traversal inside the origin', () => {
    expect(safeNavTarget('/../x', SCOPE).href).toBe('https://app.example/x');
  });
});
