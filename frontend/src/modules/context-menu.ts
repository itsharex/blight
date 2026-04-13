import { GetContextActions, ExecuteContextAction } from '../../wailsjs/go/main/App';
import { escapeHtml } from './utils';
import { main } from '../../wailsjs/go/models';

export type ContextActionCallback = (actionId: string, response: string, title: string) => void;

export class ContextMenu {
    private menuEl: HTMLElement;
    private onAction: ContextActionCallback;

    private target: string | null = null;
    private actions: main.ContextAction[] = [];
    private selectedIndex = -1;

    constructor(menuEl: HTMLElement, onAction: ContextActionCallback) {
        this.menuEl = menuEl;
        this.onAction = onAction;
    }

    get isVisible(): boolean {
        return !this.menuEl.classList.contains('hidden');
    }

    async show(
        x: number,
        y: number,
        resultId: string,
        resultTitle: string,
        fromKeyboard = false
    ): Promise<void> {
        this.target = resultId;
        const actions = await GetContextActions(resultId);
        if (actions.length === 0) return;

        this.actions = actions;
        this.selectedIndex = fromKeyboard ? 0 : -1;
        this._render(resultTitle);

        this.menuEl.style.left = '0px';
        this.menuEl.style.top = '0px';
        const rect = this.menuEl.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width - 8;
        const maxY = window.innerHeight - rect.height - 8;
        this.menuEl.style.left = `${Math.min(Math.max(x - rect.width, 8), maxX)}px`;
        this.menuEl.style.top = `${Math.min(Math.max(y, 8), maxY)}px`;
    }

    hide(): void {
        this.menuEl.classList.add('hidden');
        this.target = null;
        this.selectedIndex = -1;
        this.actions = [];
    }

    handleKeydown(e: KeyboardEvent): void {
        if (this.actions.length === 0) return;
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.selectedIndex = (this.selectedIndex + 1) % this.actions.length;
                this._updateSelection();
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.selectedIndex =
                    (this.selectedIndex - 1 + this.actions.length) % this.actions.length;
                this._updateSelection();
                break;
            case 'Enter':
                e.preventDefault();
                if (this.selectedIndex >= 0 && this.target) {
                    const action = this.actions[this.selectedIndex];
                    ExecuteContextAction(this.target, action.id).then((response) => {
                        const title =
                            this.menuEl.querySelector('.context-menu-header')?.textContent ?? '';
                        this.hide();
                        this.onAction(action.id, response, title);
                    });
                }
                break;
            case 'Escape':
                e.preventDefault();
                this.hide();
                break;
        }
    }

    private _render(resultTitle: string): void {
        let html = '';
        if (resultTitle) {
            html += `<div class="context-menu-header">${escapeHtml(resultTitle)}</div>`;
        }
        this.actions.forEach((action, idx) => {
            const kbClass = idx === this.selectedIndex ? ' kb-selected' : '';
            let shortcutHtml = '';
            if (idx === 0) shortcutHtml = `<kbd class="context-action-shortcut">↵</kbd>`;
            else if (idx === 1) shortcutHtml = `<kbd class="context-action-shortcut">⌃↵</kbd>`;
            html += `
                <button class="context-action${kbClass}" data-action="${action.id}" data-idx="${idx}">
                    <span class="context-action-icon">${action.icon}</span>
                    <span class="context-action-label">${escapeHtml(action.label)}</span>
                    ${shortcutHtml}
                </button>
            `;
        });
        this.menuEl.innerHTML = html;
        this.menuEl.classList.remove('hidden');

        this.menuEl.querySelectorAll<HTMLElement>('.context-action').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const actionId = btn.dataset['action'];
                if (!actionId || !this.target) return;
                const response = await ExecuteContextAction(this.target, actionId);
                this.hide();
                this.onAction(actionId, response, resultTitle);
            });
            btn.addEventListener('mouseenter', () => {
                this.selectedIndex = parseInt(btn.dataset['idx'] ?? '0', 10);
                this._updateSelection();
            });
        });
    }

    private _updateSelection(): void {
        this.menuEl.querySelectorAll('.context-action').forEach((btn, idx) => {
            btn.classList.toggle('kb-selected', idx === this.selectedIndex);
        });
    }
}
