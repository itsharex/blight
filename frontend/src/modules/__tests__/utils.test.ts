import { describe, it, expect } from 'vitest';
import { escapeHtml, highlightMatch } from '../utils';

describe('escapeHtml', () => {
    it('escapes ampersand', () => {
        expect(escapeHtml('a & b')).toBe('a &amp; b');
    });

    it('escapes less-than', () => {
        expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    });

    it('escapes greater-than', () => {
        expect(escapeHtml('a > b')).toBe('a &gt; b');
    });

    it('escapes double quotes', () => {
        expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
    });

    it('escapes all special chars in an XSS payload', () => {
        expect(escapeHtml('<script>alert("xss")</script>')).toBe(
            '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
        );
    });

    it('returns empty string for empty input', () => {
        expect(escapeHtml('')).toBe('');
    });

    it('returns empty string for non-string input', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(escapeHtml(null as any)).toBe('');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(escapeHtml(undefined as any)).toBe('');
    });

    it('leaves safe strings unchanged', () => {
        expect(escapeHtml('hello world')).toBe('hello world');
    });

    it('escapes multiple occurrences of special chars', () => {
        expect(escapeHtml('1 < 2 & 3 > 0')).toBe('1 &lt; 2 &amp; 3 &gt; 0');
    });
});

describe('highlightMatch', () => {
    it('returns escaped text when query is empty', () => {
        expect(highlightMatch('hello', '')).toBe('hello');
    });

    it('escapes HTML in plain text when query is empty', () => {
        expect(highlightMatch('<b>bold</b>', '')).toBe('&lt;b&gt;bold&lt;/b&gt;');
    });

    it('wraps a substring match with match-chars span', () => {
        const result = highlightMatch('Firefox', 'fire');
        expect(result).toContain('<span class="match-chars">Fire</span>');
    });

    it('is case-insensitive for substring matching', () => {
        const result = highlightMatch('Visual Studio Code', 'studio');
        expect(result).toContain('<span class="match-chars">Studio</span>');
    });

    it('includes text before and after the match', () => {
        const result = highlightMatch('my firefox browser', 'firefox');
        expect(result).toContain('my ');
        expect(result).toContain(' browser');
        expect(result).toContain('<span class="match-chars">firefox</span>');
    });

    it('falls back to per-character fuzzy highlighting', () => {
        // 'ffx' is not a substring of 'FireFox', so individual chars get wrapped
        const result = highlightMatch('FireFox', 'ffx');
        expect(result).toContain('match-char');
    });

    it('returns full text when nothing matches in fuzzy mode', () => {
        // 'zzz' cannot be found as a subsequence in 'hello'
        const result = highlightMatch('hello', 'zzz');
        expect(result).toBe('hello');
    });
});
