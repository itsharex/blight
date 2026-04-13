import { escapeHtml } from './utils';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export class Toast {
    private brandEl: HTMLElement;
    private toastEl: HTMLElement;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private hovered = false;

    constructor(brandEl: HTMLElement, toastEl: HTMLElement) {
        this.brandEl = brandEl;
        this.toastEl = toastEl;
    }

    show(message: string, _detail = '', type: ToastType = 'info'): void {
        const icons: Record<ToastType, string> = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: '•',
        };

        this.brandEl.classList.add('hidden-by-toast');
        this.toastEl.className = `toast toast--${type}`;
        this.toastEl.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${escapeHtml(message)}</span>`;
        this.toastEl.classList.add('visible');

        this.hovered = false;

        this.toastEl.onmouseenter = () => {
            this.hovered = true;
            clearTimeout(this.timer ?? undefined);
        };

        this.toastEl.onmouseleave = () => {
            this.hovered = false;
            this._scheduleDismiss();
        };

        clearTimeout(this.timer ?? undefined);
        this._scheduleDismiss();
    }

    private _scheduleDismiss(): void {
        this.timer = setTimeout(() => {
            if (this.hovered) return;
            this.toastEl.classList.remove('visible');
            this.brandEl.classList.remove('hidden-by-toast');
        }, 5000);
    }
}
