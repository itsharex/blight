import { describe, it, expect, beforeEach } from 'vitest';
import { SearchHistory } from '../search-history';

const STORAGE_KEY = 'blight-search-history';

describe('SearchHistory', () => {
    let container: HTMLElement;
    let input: HTMLInputElement;
    let selected: string[];
    let history: SearchHistory;

    beforeEach(() => {
        localStorage.clear();
        container = document.createElement('div');
        input = document.createElement('input');
        selected = [];
        history = new SearchHistory(container, input, (q) => selected.push(q));
    });

    describe('add()', () => {
        it('stores a query in localStorage', () => {
            history.add('vscode');
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
            expect(stored).toContain('vscode');
        });

        it('ignores empty strings', () => {
            history.add('');
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
            expect(stored).toHaveLength(0);
        });

        it('ignores single-character strings', () => {
            history.add('x');
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
            expect(stored).toHaveLength(0);
        });

        it('deduplicates and moves existing entry to the front', () => {
            history.add('chrome');
            history.add('firefox');
            history.add('chrome');
            const stored: string[] = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
            expect(stored[0]).toBe('chrome');
            expect(stored.filter((q) => q === 'chrome')).toHaveLength(1);
        });

        it('places most recent entry first', () => {
            history.add('first');
            history.add('second');
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
            expect(stored[0]).toBe('second');
        });

        it('trims history to 10 entries maximum', () => {
            for (let i = 0; i < 15; i++) {
                history.add(`query-${i}`);
            }
            const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
            expect(stored).toHaveLength(10);
        });
    });

    describe('hide()', () => {
        it('adds the hidden class to the container', () => {
            history.hide();
            expect(container.classList.contains('hidden')).toBe(true);
        });

        it('sets aria-expanded to false on the input', () => {
            history.hide();
            expect(input.getAttribute('aria-expanded')).toBe('false');
        });
    });

    describe('show()', () => {
        it('keeps container hidden when history is empty', () => {
            history.show();
            expect(container.classList.contains('hidden')).toBe(true);
        });

        it('renders history items and removes the hidden class', () => {
            history.add('chrome');
            history.add('vscode');
            history.show();
            expect(container.classList.contains('hidden')).toBe(false);
            expect(container.querySelectorAll('.history-item').length).toBe(2);
        });

        it('sets aria-expanded to true on the input when items exist', () => {
            history.add('chrome');
            history.show();
            expect(input.getAttribute('aria-expanded')).toBe('true');
        });

        it('renders a history-header element', () => {
            history.add('something');
            history.show();
            expect(container.querySelector('.history-header')).not.toBeNull();
        });

        it('escapes HTML in history item text', () => {
            history.add('<b>xss</b>');
            history.show();
            expect(container.innerHTML).not.toContain('<b>xss</b>');
            expect(container.innerHTML).toContain('&lt;b&gt;xss&lt;/b&gt;');
        });
    });
});
