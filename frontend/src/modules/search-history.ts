import { escapeHtml } from './utils';

const STORAGE_KEY = 'blight-search-history';
const MAX_HISTORY = 10;

export class SearchHistory {
    private containerEl: HTMLElement;
    private searchInputEl: HTMLInputElement;
    private onSelect: (query: string) => void;
    private history: string[];

    constructor(
        containerEl: HTMLElement,
        searchInputEl: HTMLInputElement,
        onSelect: (query: string) => void
    ) {
        this.containerEl = containerEl;
        this.searchInputEl = searchInputEl;
        this.onSelect = onSelect;
        this.history = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    }

    add(query: string): void {
        if (!query || query.length < 2) return;
        this.history = [query, ...this.history.filter((q) => q !== query)].slice(0, MAX_HISTORY);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.history));
    }

    show(): void {
        if (this.history.length === 0) {
            this.containerEl.classList.add('hidden');
            return;
        }
        this.containerEl.innerHTML =
            `<div class="history-header">Recent</div>` +
            this.history
                .map(
                    (q, i) => `
                <div class="history-item" data-index="${i}" role="option">
                    <span class="history-item-icon">↺</span>
                    <span class="history-item-text">${escapeHtml(q)}</span>
                    <span class="history-item-remove" data-remove="${i}" title="Remove">✕</span>
                </div>
            `
                )
                .join('');
        this.containerEl.classList.remove('hidden');

        this.containerEl.querySelectorAll<HTMLElement>('.history-item').forEach((item) => {
            item.addEventListener('mousedown', (e) => {
                const remove = (e.target as HTMLElement).closest(
                    '[data-remove]'
                ) as HTMLElement | null;
                if (remove) {
                    e.preventDefault();
                    const idx = parseInt(remove.dataset['remove'] ?? '0', 10);
                    this.history.splice(idx, 1);
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.history));
                    this.show();
                    return;
                }
                e.preventDefault();
                const idx = parseInt(item.dataset['index'] ?? '0', 10);
                this.searchInputEl.value = this.history[idx] ?? '';
                this.hide();
                this.onSelect(this.searchInputEl.value);
            });
        });

        this.searchInputEl.setAttribute('aria-expanded', 'true');
    }

    hide(): void {
        this.containerEl.classList.add('hidden');
        this.searchInputEl.setAttribute('aria-expanded', 'false');
    }
}
