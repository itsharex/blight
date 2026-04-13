export class CalcPreview {
    private el: HTMLElement;

    constructor(el: HTMLElement) {
        this.el = el;
    }

    update(query: string): void {
        const calcRegex = /^[\d\s+\-*/().]+$/;
        if (calcRegex.test(query) && /[+\-*/]/.test(query)) {
            try {
                const result = Function('"use strict"; return (' + query + ')')();
                if (typeof result === 'number' && isFinite(result)) {
                    this.el.textContent =
                        '= ' +
                        (Number.isInteger(result)
                            ? result.toString()
                            : result.toFixed(6).replace(/\.?0+$/, ''));
                    this.el.setAttribute('aria-hidden', 'false');
                    return;
                }
            } catch {
                /* ignore */
            }
        }
        this.clear();
    }

    clear(): void {
        this.el.textContent = '';
        this.el.setAttribute('aria-hidden', 'true');
    }
}
