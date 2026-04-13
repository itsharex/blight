import { describe, it, expect, beforeEach } from 'vitest';
import { CalcPreview } from '../calc-preview';

describe('CalcPreview', () => {
    let el: HTMLElement;
    let preview: CalcPreview;

    beforeEach(() => {
        el = document.createElement('div');
        preview = new CalcPreview(el);
    });

    it('shows result for simple addition', () => {
        preview.update('1 + 2');
        expect(el.textContent).toBe('= 3');
    });

    it('shows result for subtraction', () => {
        preview.update('10 - 4');
        expect(el.textContent).toBe('= 6');
    });

    it('shows result for multiplication', () => {
        preview.update('4 * 5');
        expect(el.textContent).toBe('= 20');
    });

    it('shows result for division', () => {
        preview.update('15 / 3');
        expect(el.textContent).toBe('= 5');
    });

    it('shows a trimmed decimal result', () => {
        preview.update('10 / 3');
        // Should be a decimal number, not show trailing zeros
        expect(el.textContent).toMatch(/^= \d+\.\d+$/);
        expect(el.textContent).not.toMatch(/0+$/);
    });

    it('respects operator precedence', () => {
        preview.update('2 + 3 * 4');
        expect(el.textContent).toBe('= 14');
    });

    it('clears for non-numeric input', () => {
        preview.update('hello world');
        expect(el.textContent).toBe('');
    });

    it('clears for a number without operators', () => {
        preview.update('42');
        expect(el.textContent).toBe('');
    });

    it('clears after having shown a result', () => {
        preview.update('1 + 1');
        preview.update('');
        expect(el.textContent).toBe('');
    });

    it('sets aria-hidden to false when showing a result', () => {
        preview.update('2 + 2');
        expect(el.getAttribute('aria-hidden')).toBe('false');
    });

    it('sets aria-hidden to true when cleared via clear()', () => {
        preview.clear();
        expect(el.getAttribute('aria-hidden')).toBe('true');
    });

    it('sets aria-hidden to true when input is non-math', () => {
        preview.update('not math');
        expect(el.getAttribute('aria-hidden')).toBe('true');
    });
});
