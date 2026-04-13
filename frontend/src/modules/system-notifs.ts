import { escapeHtml } from './utils';

export interface SystemNotif {
    icon: string;
    title: string;
    subtitle: string;
    action?: () => void;
}

export class SystemNotifications {
    private resultsContainer: HTMLElement;
    private isSpotlightMode: () => boolean;
    readonly notifs: Map<string, SystemNotif> = new Map();

    constructor(resultsContainer: HTMLElement, isSpotlightMode: () => boolean) {
        this.resultsContainer = resultsContainer;
        this.isSpotlightMode = isSpotlightMode;
    }

    set(id: string, notif: SystemNotif): void {
        this.notifs.set(id, notif);
    }

    delete(id: string): void {
        this.notifs.delete(id);
    }

    get(id: string): SystemNotif | undefined {
        return this.notifs.get(id);
    }

    get size(): number {
        return this.notifs.size;
    }

    refresh(): void {
        if (this.isSpotlightMode()) return;

        const existing = document.getElementById('system-notifs-section');

        if (this.notifs.size === 0) {
            existing?.remove();
            return;
        }

        let inner = `<div class="result-category">Notification</div>`;
        for (const [id, n] of this.notifs) {
            inner += `<div class="result-item notif-result-item" data-notif-id="${escapeHtml(id)}" style="${n.action ? 'cursor:pointer' : ''}">
                <div class="result-icon-fallback">${n.icon}</div>
                <div class="result-text">
                    <div class="result-title">${escapeHtml(n.title)}</div>
                    ${n.subtitle ? `<div class="result-subtitle">${escapeHtml(n.subtitle)}</div>` : ''}
                </div>
            </div>`;
        }

        if (existing) {
            existing.innerHTML = inner;
        } else {
            const section = document.createElement('div');
            section.id = 'system-notifs-section';
            section.innerHTML = inner;
            this.resultsContainer.insertBefore(section, this.resultsContainer.firstChild);
        }

        this.resultsContainer.querySelectorAll<HTMLElement>('[data-notif-id]').forEach((el) => {
            const notif = this.notifs.get(el.dataset['notifId']!);
            if (notif?.action) el.addEventListener('click', notif.action, { once: true });
        });
    }
}
