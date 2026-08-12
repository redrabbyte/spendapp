import { describe, expect, it } from 'vitest';
import { localPath, safeNavTarget } from './navSafety';

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

  it('refuses a backslash authority', () => {
    // A browser reads the backslash as a slash, so `/\host` is another origin
    // that begins with a single slash — which is what a prefix check misses.
    expect(safeNavTarget('/\\evil.example', SCOPE).href).toBe('https://app.example/');
    expect(safeNavTarget('\\/evil.example', SCOPE).href).toBe('https://app.example/');
  });
});

describe('where a `next=` may send us', () => {
  const ORIGIN = 'https://app.example';

  it('keeps an ordinary path, query and fragment', () => {
    expect(localPath('/g/123', ORIGIN)).toBe('/g/123');
    expect(localPath('/g/123?tab=members#x', ORIGIN)).toBe('/g/123?tab=members#x');
  });

  it('sends anything off-origin home', () => {
    for (const hostile of [
      'https://evil.example/login',
      '//evil.example',
      '/\\evil.example',
      '\\/evil.example',
      '/\\\\evil.example',
    ]) {
      expect(localPath(hostile, ORIGIN)).toBe('/');
    }
  });

  it('falls home on nothing at all', () => {
    expect(localPath(null, ORIGIN)).toBe('/');
    expect(localPath(undefined, ORIGIN)).toBe('/');
    expect(localPath('', ORIGIN)).toBe('/');
  });

  it('keeps traversal inside the origin', () => {
    expect(localPath('/../secrets', ORIGIN)).toBe('/secrets');
  });
});
