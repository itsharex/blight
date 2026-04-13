const FILTERS = [
    { label: 'Apps', value: 'applications' },
    { label: 'Files', value: 'files' },
    { label: 'Folders', value: 'folders' },
    { label: 'Clip', value: 'clipboard' },
    { label: 'System', value: 'system' },
];

export class FilterPills {
    private containerEl: HTMLElement;
    private onChange: (filter: string | null) => void;
    private activeFilter: string | null = null;

    constructor(containerEl: HTMLElement, onChange: (filter: string | null) => void) {
        this.containerEl = containerEl;
        this.onChange = onChange;
    }

    render(activeFilter: string | null): void {
        this.activeFilter = activeFilter;
        this.containerEl.innerHTML = FILTERS.map(
            (f) => `
            <button class="filter-pill ${activeFilter === f.value ? 'active' : ''}"
                data-filter="${f.value}"
                title="Show only ${f.label} (Ctrl+${f.label[0]})">${f.label}</button>
        `
        ).join('');
        this.containerEl.querySelectorAll<HTMLElement>('.filter-pill').forEach((pill) => {
            pill.addEventListener('click', () => {
                const v = pill.dataset['filter'] ?? null;
                const next = this.activeFilter === v ? null : v;
                this.onChange(next);
            });
        });
    }
}
