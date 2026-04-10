import {
    IsFirstRun, IsSettingsMode, CompleteOnboarding, Search, Execute, HideWindow,
    GetContextActions, ExecuteContextAction, CheckForUpdates, InstallUpdate,
    GetIcon, GetConfig, SaveSettings, GetVersion, ReindexFiles, ClearIndex,
    CloseSettings, GetStartupEnabled, OpenFolderPicker,
    GetDataDir, GetInstallDir, OpenFolder, Uninstall, CancelIndex
} from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';
import { main, files } from '../wailsjs/go/models';

interface SystemNotif {
    icon: string;
    title: string;
    subtitle: string;
    action?: () => void;
}

function inputEl(id: string): HTMLInputElement | null {
    const el = document.getElementById(id);
    return el instanceof HTMLInputElement ? el : null;
}

function selectEl(id: string): HTMLSelectElement | null {
    const el = document.getElementById(id);
    return el instanceof HTMLSelectElement ? el : null;
}

class Blight {
    selectedIndex: number;
    results: main.SearchResult[];
    searchSeq: number;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    toastTimer: ReturnType<typeof setTimeout> | null;
    toastHovered: boolean;
    contextTarget: string | null;
    contextMenuSelectedIndex: number;
    contextMenuActions: main.ContextAction[];
    currentQuery: string;
    settingsMode: boolean;

    searchDelay: number;
    hideWhenDeactivated: boolean;
    lastQueryMode: string;

    iconCache: Map<string, string>;
    renderSeq: number;

    activeNotifs: Map<string, SystemNotif>;
    _currentIndexDirs: string[];
    lastUpdateCheck: number;

    currentSlide: number;
    lastShownAt: number;
    isHiding: boolean;

    searchInput: HTMLInputElement;
    resultsContainer: HTMLElement;
    splashEl: HTMLElement;
    launcherEl: HTMLElement;
    contextMenuEl: HTMLElement;
    settingsPanelEl: HTMLElement;

    constructor() {
        this.selectedIndex = 0;
        this.results = [];
        this.searchSeq = 0;
        this.debounceTimer = null;
        this.toastTimer = null;
        this.toastHovered = false;
        this.contextTarget = null;
        this.contextMenuSelectedIndex = -1;
        this.contextMenuActions = [];
        this.currentQuery = '';
        this.settingsMode = false;

        this.searchDelay = 120;
        this.hideWhenDeactivated = true;
        this.lastQueryMode = 'clear';

        this.iconCache = new Map();
        this.renderSeq = 0;

        this.activeNotifs = new Map();
        this._currentIndexDirs = [];
        this.lastUpdateCheck = 0;

        this.currentSlide = 0;
        this.lastShownAt = 0;
        this.isHiding = false;

        this.searchInput = document.getElementById('search-input') as HTMLInputElement;
        this.resultsContainer = document.getElementById('results')!;
        this.splashEl = document.getElementById('splash')!;
        this.launcherEl = document.getElementById('app')!;
        this.contextMenuEl = document.getElementById('context-menu')!;
        this.settingsPanelEl = document.getElementById('settings-panel')!;
        this.init();
    }

    async init(): Promise<void> {
        const settingsMode = await IsSettingsMode();
        if (settingsMode) {
            this.settingsMode = true;
            document.body.classList.add('settings-only');
            this.bindSettings();
            this.openSettings();
            return;
        }

        try {
            const config = await GetConfig();
            this._applyRuntimeSettings(config);
            this._currentIndexDirs = config.indexDirs || [];
        } catch (e) {
            console.error('Failed to load config on init:', e);
        }

        const firstRun = await IsFirstRun();
        if (firstRun) {
            this.showSplash();
        } else {
            this.showLauncher();
        }

        this.checkForUpdates();
    }

    async checkForUpdates(): Promise<void> {
        try {
            const update = await CheckForUpdates();
            if (update && update.available) {
                this.showUpdateUI(update);
            }
        } catch (e) {
            console.error('Failed to check for updates:', e);
        }
    }

    showUpdateUI(update: main.UpdateInfo): void {
        this.activeNotifs.set('update', {
            icon: '⬇',
            title: `Update v${update.version} available`,
            subtitle: 'Click to install',
            action: () => this.installUpdate(update),
        });
        this._refreshSystemNotifs();

        const row = document.getElementById('settings-update-install-row');
        const label = document.getElementById('settings-update-version-label');
        const installBtn = document.getElementById('settings-install-update') as HTMLButtonElement | null;
        if (row) row.classList.remove('hidden');
        if (label) label.textContent = `v${update.version} available`;
        if (installBtn) installBtn.onclick = () => this.installUpdate(update);
    }

    showConfirmModal(title: string, body: string, okLabel: string, danger: boolean, onOk: () => void): void {
        const modal = document.getElementById('confirm-modal')!;
        document.getElementById('confirm-modal-title')!.textContent = title;
        document.getElementById('confirm-modal-body')!.textContent = body;
        const okBtn = document.getElementById('confirm-modal-ok') as HTMLButtonElement;
        okBtn.textContent = okLabel;
        okBtn.className = danger ? 'settings-btn settings-btn-danger' : 'settings-btn settings-btn-primary';
        const cancelBtn = document.getElementById('confirm-modal-cancel')!;
        const cleanup = () => { modal.classList.add('hidden'); okBtn.onclick = null; cancelBtn.onclick = null; };
        okBtn.onclick = () => { cleanup(); onOk(); };
        cancelBtn.onclick = () => cleanup();
        modal.classList.remove('hidden');
    }

    async installUpdate(update: main.UpdateInfo): Promise<void> {
        this.showConfirmModal(
            `Install update ${update.version}?`,
            'The installer will close and restart blight automatically.',
            'Install',
            false,
            async () => {
                this._activateSettingsTab('updates');
                this.settingsPanelEl.classList.remove('hidden');

                const bar = document.getElementById('settings-update-progress-bar');
                const fill = document.getElementById('settings-update-progress-fill') as HTMLElement | null;
                const text = document.getElementById('settings-update-progress-text');
                if (bar) bar.style.display = 'block';
                if (text) text.textContent = 'Downloading…';

                const unsub = EventsOn('updateProgress', (pct: number) => {
                    if (fill) fill.style.width = pct + '%';
                    if (text) text.textContent = `Downloading… ${pct}%`;
                });

                const res = await InstallUpdate();
                unsub();

                if (res === 'success') {
                    if (text) text.textContent = 'Installing — blight will restart shortly';
                } else {
                    if (bar) bar.style.display = 'none';
                    if (text) text.textContent = '';
                    this.showToast('Update failed', res);
                }
            }
        );
    }

    showSplash(): void {
        this.splashEl.classList.remove('hidden');
        this.launcherEl.classList.add('hidden');
        this.initSplash();
    }

    showLauncher(): void {
        this.splashEl.classList.add('hidden');
        this.launcherEl.classList.remove('hidden');
        setTimeout(() => this.searchInput.focus(), 50);
        this.bindEvents();
        this.listenIndexStatus();
        this.bindSettings();
        this.loadDefaultResults();
    }

    // --- Splash ---

    initSplash(): void {
        this.currentSlide = 0;

        document.getElementById('splash-next')?.addEventListener('click', () => {
            if (this.currentSlide < 3) this.goToSlide(this.currentSlide + 1);
        });

        document.getElementById('splash-skip')?.addEventListener('click', () => this.completeSplash());
        document.getElementById('splash-go')?.addEventListener('click', () => this.completeSplash());

        document.querySelectorAll<HTMLElement>('.splash-dot').forEach(dot => {
            dot.addEventListener('click', () => this.goToSlide(parseInt(dot.dataset['dot'] ?? '0', 10)));
        });
    }

    goToSlide(index: number): void {
        document.querySelectorAll('.splash-slide').forEach((slide, i) => {
            slide.classList.remove('active', 'exit-left');
            if (i < index) slide.classList.add('exit-left');
            if (i === index) slide.classList.add('active');
        });

        document.querySelectorAll('.splash-dot').forEach((dot, i) => {
            dot.classList.toggle('active', i === index);
        });

        const nextBtn = document.getElementById('splash-next');
        if (nextBtn) nextBtn.style.visibility = index >= 3 ? 'hidden' : 'visible';
        this.currentSlide = index;
    }

    async completeSplash(): Promise<void> {
        await CompleteOnboarding('Alt+Space');
        this.splashEl.style.animation = 'splashOut 250ms ease forwards';
        setTimeout(() => this.showLauncher(), 250);
    }

    // --- Events ---

    bindEvents(): void {
        this.searchInput.addEventListener('input', () => this.onSearchInput());

        document.addEventListener('keydown', (e) => {
            if (!this.settingsPanelEl.classList.contains('hidden')) {
                if (e.key === 'Escape') {
                    this.closeSettings();
                    e.preventDefault();
                }
                return;
            }

            if (!this.contextMenuEl.classList.contains('hidden')) {
                this.handleContextMenuKeydown(e);
                return;
            }

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    this.moveSelection(1);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this.moveSelection(-1);
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (e.ctrlKey) {
                        this.executeSecondaryAction();
                    } else {
                        this.executeSelected();
                    }
                    break;
                case 'k':
                case 'K':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        this.openActionPanelForSelected();
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    if (this.searchInput.value) {
                        this.searchInput.value = '';
                        this.currentQuery = '';
                        this.loadDefaultResults();
                    } else {
                        HideWindow();
                    }
                    break;
            }
        });

        document.addEventListener('click', (e) => {
            const target = e.target;
            if (target instanceof Node) {
                if (!this.contextMenuEl.contains(target)) {
                    this.hideContextMenu();
                }
            }
        });

        const settingsBtn = document.getElementById('settings-open-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => this.openSettings());
        }

        this.lastShownAt = Date.now();
        this.isHiding = false;
        EventsOn('windowShown', () => {
            this.lastShownAt = Date.now();
            this.isHiding = false;
            if (this.lastQueryMode !== 'preserve') {
                this.searchInput.value = '';
                this.currentQuery = '';
                this.loadDefaultResults();
            }
            setTimeout(() => {
                this.searchInput.focus();
                this.searchInput.select();
            }, 30);
        });
        window.addEventListener('blur', () => {
            if (!this.hideWhenDeactivated) return;
            if (this.isHiding) return;
            if (Date.now() - this.lastShownAt < 600) return;
            this.isHiding = true;
            HideWindow();
        });

        EventsOn('openSettings', () => this.openSettings());
    }

    onSearchInput(): void {
        clearTimeout(this.debounceTimer ?? undefined);
        const query = this.searchInput.value.trim();
        if (!query) {
            this.setLoading(false);
            this.loadDefaultResults();
            return;
        }
        this.launcherEl.classList.remove('spotlight-mode');
        this.setLoading(true);
        this.debounceTimer = setTimeout(async () => {
            const seq = ++this.searchSeq;
            const results = await Search(query);
            this.setLoading(false);
            if (seq !== this.searchSeq) return;
            this.currentQuery = query;
            this.results = results;
            this.selectedIndex = 0;
            this.renderResults();
        }, this.searchDelay);
    }

    _applyRuntimeSettings(cfg: main.BlightConfig): void {
        if (cfg.searchDelay > 0) this.searchDelay = cfg.searchDelay;
        this.hideWhenDeactivated = cfg.hideWhenDeactivated !== false;
        this.lastQueryMode = cfg.lastQueryMode || 'clear';

        if (cfg.showPlaceholder !== false) {
            this.searchInput.placeholder = cfg.placeholderText || 'Search apps, commands, files…';
        } else {
            this.searchInput.placeholder = '';
        }

        document.documentElement.classList.toggle('no-animations', !cfg.useAnimation);
        document.documentElement.dataset['theme'] = cfg.theme || 'dark';
    }

    loadDefaultResults(): void {
        this.searchSeq++;
        this.currentQuery = '';
        this.results = [];
        this.selectedIndex = 0;
        this.resultsContainer.innerHTML = '';
        this.launcherEl.classList.add('spotlight-mode');
        this.updateFooterHints(null);
    }

    setLoading(loading: boolean): void {
        const loaderEl = document.getElementById('search-loader');
        if (loaderEl) loaderEl.classList.toggle('visible', loading);
    }

    moveSelection(delta: number): void {
        if (this.results.length === 0) return;
        const items = this.resultsContainer.querySelectorAll<HTMLElement>('.result-item');
        if (items.length === 0) return;
        items[this.selectedIndex]?.classList.remove('selected');
        this.selectedIndex = (this.selectedIndex + delta + this.results.length) % this.results.length;
        const next = items[this.selectedIndex];
        if (next) {
            next.classList.add('selected');
            next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        this.updateFooterHints(this.results[this.selectedIndex] ?? null);
    }

    async executeSelected(): Promise<void> {
        if (this.results.length === 0) return;
        const result = this.results[this.selectedIndex];

        if (result.id === 'calc-result') {
            await navigator.clipboard.writeText(result.title);
            this.showToast('Copied result', result.title);
            return;
        }

        if (result.id.startsWith('web-search:')) {
            await Execute(result.id);
            return;
        }

        const response = await Execute(result.id);
        if (response === 'copied') {
            this.showToast('Copied to clipboard', result.title);
        } else if (response === 'ok') {
            if (result.id.startsWith('sys-')) {
                this.showToast(result.title, result.subtitle);
            } else {
                this.showToast(`Launched ${result.title}`, result.path || '');
            }
        }
    }

    async executeSecondaryAction(): Promise<void> {
        if (this.results.length === 0) return;
        const result = this.results[this.selectedIndex];
        const actionId = this.getSecondaryActionId(result.id);
        if (!actionId) return;

        const response = await ExecuteContextAction(result.id, actionId);
        this.handleContextResponse(actionId, response, result.title);
    }

    getSecondaryActionId(resultId: string): string | null {
        if (resultId.startsWith('file-open:')) return 'explorer';
        if (resultId.startsWith('clip-')) return 'copy';
        if (resultId.startsWith('sys-')) return null;
        if (resultId.startsWith('web-search:')) return null;
        if (resultId === 'calc-result') return null;
        return 'admin';
    }

    getSecondaryActionLabel(resultId: string): string {
        if (resultId.startsWith('file-open:')) return 'Show in Explorer';
        if (resultId.startsWith('clip-')) return 'Copy';
        return 'Run as Admin';
    }

    // --- Action Panel (Ctrl+K) ---

    async openActionPanelForSelected(): Promise<void> {
        if (this.results.length === 0) return;
        const result = this.results[this.selectedIndex];
        const selectedEl = this.resultsContainer.querySelector('.result-item.selected');

        let x: number, y: number;
        if (selectedEl) {
            const rect = selectedEl.getBoundingClientRect();
            x = rect.right - 8;
            y = rect.bottom;
        } else {
            x = window.innerWidth - 8;
            y = window.innerHeight / 2;
        }

        await this.showContextMenu(x, y, result.id, result.title, true);
    }

    // --- Rendering ---

    renderResults(): void {
        const renderSeq = ++this.renderSeq;
        this.launcherEl.classList.remove('spotlight-mode');
        if (this.results.length === 0) {
            this.resultsContainer.innerHTML = `
                <div class="no-results">
                    <div style="font-size: 24px; opacity: 0.3;">⌕</div>
                    <div>No results found</div>
                </div>
            `;
            this.updateFooterHints(null);
            return;
        }

        let html = '';
        let lastCategory = '';

        this.results.forEach((result, index) => {
            if (result.category !== lastCategory) {
                html += `<div class="result-category">${this.escapeHtml(result.category)}</div>`;
                lastCategory = result.category;
            }

            const selected = index === this.selectedIndex ? 'selected' : '';
            let iconHtml: string;
            const cachedIcon = result.path ? this.iconCache.get(result.path) : null;
            const iconSrc = (result.icon && result.icon.startsWith('data:')) ? result.icon : cachedIcon;
            if (iconSrc) {
                iconHtml = `<div class="result-icon"><img src="${iconSrc}" alt=""/></div>`;
            } else {
                const fallbackSvg = this.getFallbackIcon(result.category);
                iconHtml = `<div class="result-icon result-icon-fallback" data-icon-index="${index}">${fallbackSvg}</div>`;
            }

            const titleHtml = this.highlightMatch(result.title, this.currentQuery);

            html += `
                <div class="result-item ${selected}" data-index="${index}" data-id="${result.id}">
                    ${iconHtml}
                    <div class="result-text">
                        <div class="result-title">${titleHtml}</div>
                        <div class="result-subtitle">${this.escapeHtml(result.subtitle)}</div>
                    </div>
                    <div class="result-badge">${this.escapeHtml(result.category)}</div>
                </div>
            `;
        });

        this.resultsContainer.innerHTML = html;

        this.resultsContainer.querySelectorAll<HTMLElement>('.result-item').forEach(item => {
            item.addEventListener('click', () => {
                this.selectedIndex = parseInt(item.dataset['index'] ?? '0', 10);
                this.executeSelected();
            });

            item.addEventListener('mouseenter', () => {
                const prev = this.resultsContainer.querySelector('.result-item.selected');
                if (prev && prev !== item) prev.classList.remove('selected');
                item.classList.add('selected');
                this.selectedIndex = parseInt(item.dataset['index'] ?? '0', 10);
                this.updateFooterHints(this.results[this.selectedIndex] ?? null);
            });

            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const prev = this.resultsContainer.querySelector('.result-item.selected');
                if (prev && prev !== item) prev.classList.remove('selected');
                item.classList.add('selected');
                this.selectedIndex = parseInt(item.dataset['index'] ?? '0', 10);
                this.showContextMenu(e.clientX, e.clientY, item.dataset['id'] ?? '', item.querySelector('.result-title')?.textContent ?? '', false);
            });
        });

        this.results.forEach((result, index) => {
            if (!result.path || this.iconCache.has(result.path)) return;
            if (result.icon && result.icon.startsWith('data:')) return;
            GetIcon(result.path).then(icon => {
                if (!icon || this.renderSeq !== renderSeq) return;
                this.iconCache.set(result.path, icon);
                const el = this.resultsContainer.querySelector(`[data-icon-index="${index}"]`);
                if (el) el.outerHTML = `<div class="result-icon"><img src="${icon}" alt=""/></div>`;
            }).catch(() => {});
        });

        this.updateFooterHints(this.results[this.selectedIndex] ?? null);
        this._refreshSystemNotifs();
    }

    updateFooterHints(result: main.SearchResult | null): void {
        const secondaryHint = document.getElementById('footer-hint-secondary');
        if (!secondaryHint) return;

        if (!result) {
            secondaryHint.classList.add('hidden');
            return;
        }

        const secondaryLabel = this.getSecondaryActionLabel(result.id);
        const hasSecondary = this.getSecondaryActionId(result.id) !== null;

        if (hasSecondary) {
            secondaryHint.innerHTML = `<kbd>Ctrl+↵</kbd> ${this.escapeHtml(secondaryLabel)}`;
            secondaryHint.classList.remove('hidden');
        } else {
            secondaryHint.classList.add('hidden');
        }
    }

    // --- Match Highlighting ---

    highlightMatch(text: string, query: string): string {
        if (!query) return this.escapeHtml(text);

        const lowerText = text.toLowerCase();
        const lowerQuery = query.toLowerCase();

        const idx = lowerText.indexOf(lowerQuery);
        if (idx !== -1) {
            return this.escapeHtml(text.slice(0, idx)) +
                   `<span class="match-chars">${this.escapeHtml(text.slice(idx, idx + lowerQuery.length))}</span>` +
                   this.escapeHtml(text.slice(idx + lowerQuery.length));
        }

        let result = '';
        let qi = 0;
        for (let i = 0; i < text.length; i++) {
            if (qi < lowerQuery.length && lowerText[i] === lowerQuery[qi]) {
                result += `<span class="match-char">${this.escapeHtml(text[i])}</span>`;
                qi++;
            } else {
                result += this.escapeHtml(text[i]);
            }
        }
        return result;
    }

    escapeHtml(str: string): string {
        if (typeof str !== 'string') return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // --- Context Menu ---

    async showContextMenu(x: number, y: number, resultId: string, resultTitle: string, fromKeyboard = false): Promise<void> {
        this.contextTarget = resultId;
        const actions = await GetContextActions(resultId);

        if (actions.length === 0) return;

        this.contextMenuActions = actions;
        this.contextMenuSelectedIndex = fromKeyboard ? 0 : -1;

        this.renderContextMenu(resultTitle, fromKeyboard);

        this.contextMenuEl.style.left = '0px';
        this.contextMenuEl.style.top = '0px';
        const rect = this.contextMenuEl.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width - 8;
        const maxY = window.innerHeight - rect.height - 8;
        const targetX = Math.min(Math.max(x - rect.width, 8), maxX);
        const targetY = Math.min(Math.max(y, 8), maxY);
        this.contextMenuEl.style.left = `${targetX}px`;
        this.contextMenuEl.style.top = `${targetY}px`;
    }

    renderContextMenu(resultTitle: string, fromKeyboard: boolean): void {
        const actions = this.contextMenuActions;
        let html = '';

        if (resultTitle) {
            html += `<div class="context-menu-header">${this.escapeHtml(resultTitle)}</div>`;
        }

        actions.forEach((action, idx) => {
            const isSelected = idx === this.contextMenuSelectedIndex;
            const kbClass = isSelected ? ' kb-selected' : '';

            let shortcutHtml = '';
            if (idx === 0) {
                shortcutHtml = `<kbd class="context-action-shortcut">↵</kbd>`;
            } else if (idx === 1) {
                shortcutHtml = `<kbd class="context-action-shortcut">⌃↵</kbd>`;
            }

            html += `
                <button class="context-action${kbClass}" data-action="${action.id}" data-idx="${idx}">
                    <span class="context-action-icon">${action.icon}</span>
                    <span class="context-action-label">${this.escapeHtml(action.label)}</span>
                    ${shortcutHtml}
                </button>
            `;
        });

        this.contextMenuEl.innerHTML = html;
        this.contextMenuEl.classList.remove('hidden');

        this.contextMenuEl.querySelectorAll<HTMLElement>('.context-action').forEach(btn => {
            btn.addEventListener('click', async () => {
                const actionId = btn.dataset['action'];
                if (!actionId || !this.contextTarget) return;
                const response = await ExecuteContextAction(this.contextTarget, actionId);
                this.hideContextMenu();
                this.handleContextResponse(actionId, response, resultTitle);
            });

            btn.addEventListener('mouseenter', () => {
                this.contextMenuSelectedIndex = parseInt(btn.dataset['idx'] ?? '0', 10);
                this.reRenderContextMenuSelection();
            });
        });
    }

    handleContextMenuKeydown(e: KeyboardEvent): void {
        const actions = this.contextMenuActions;
        if (actions.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                this.contextMenuSelectedIndex = (this.contextMenuSelectedIndex + 1) % actions.length;
                this.reRenderContextMenuSelection();
                break;
            case 'ArrowUp':
                e.preventDefault();
                this.contextMenuSelectedIndex = (this.contextMenuSelectedIndex - 1 + actions.length) % actions.length;
                this.reRenderContextMenuSelection();
                break;
            case 'Enter':
                e.preventDefault();
                if (this.contextMenuSelectedIndex >= 0 && this.contextTarget) {
                    const action = actions[this.contextMenuSelectedIndex];
                    ExecuteContextAction(this.contextTarget, action.id).then(response => {
                        const resultTitle = this.results[this.selectedIndex]?.title ?? '';
                        this.hideContextMenu();
                        this.handleContextResponse(action.id, response, resultTitle);
                    });
                }
                break;
            case 'Escape':
                e.preventDefault();
                this.hideContextMenu();
                this.searchInput.focus();
                break;
        }
    }

    reRenderContextMenuSelection(): void {
        this.contextMenuEl.querySelectorAll('.context-action').forEach((btn, idx) => {
            btn.classList.toggle('kb-selected', idx === this.contextMenuSelectedIndex);
        });
    }

    handleContextResponse(actionId: string, response: string, title: string): void {
        switch (actionId) {
            case 'copy-path':
                this.showToast('Path copied', title);
                break;
            case 'copy-name':
                this.showToast('Name copied', title);
                break;
            case 'copy':
                this.showToast('Copied to clipboard', title);
                break;
            case 'delete':
                this.showToast('Deleted', title);
                this.loadDefaultResults();
                break;
            case 'admin':
                if (response === 'ok') this.showToast(`Launched as admin`, title);
                else if (response && response !== 'ok') this.showToast('Failed', response);
                break;
            case 'open':
            case 'run':
                if (response === 'ok') this.showToast(`Launched`, title);
                break;
            case 'explorer':
                break;
        }
    }

    hideContextMenu(): void {
        this.contextMenuEl.classList.add('hidden');
        this.contextTarget = null;
        this.contextMenuSelectedIndex = -1;
        this.contextMenuActions = [];
    }

    // --- Settings Panel ---

    async openSettings(): Promise<void> {
        this.settingsPanelEl.classList.remove('hidden');
        this.settingsPanelEl.style.animation = 'none';
        this.settingsPanelEl.offsetHeight; // force reflow
        this.settingsPanelEl.style.animation = '';

        this._activateSettingsTab('general');

        try {
            const [config, version, startupEnabled] = await Promise.all([
                GetConfig(), GetVersion(), GetStartupEnabled()
            ]);

            // General tab
            const hotkeyDisplay = document.getElementById('settings-hotkey-display');
            if (hotkeyDisplay) hotkeyDisplay.textContent = config.hotkey || 'Alt+Space';

            const lastQueryMode = selectEl('settings-last-query-mode');
            if (lastQueryMode) lastQueryMode.value = config.lastQueryMode || 'clear';

            const hideDeactivated = inputEl('settings-hide-deactivated');
            if (hideDeactivated) hideDeactivated.checked = config.hideWhenDeactivated !== false;

            const windowPosition = selectEl('settings-window-position');
            if (windowPosition) windowPosition.value = config.windowPosition || 'center';

            const clipSizeInput = inputEl('settings-clipboard-size');
            if (clipSizeInput) clipSizeInput.value = String(config.maxClipboard || 50);

            // Search tab
            const maxResults = inputEl('settings-max-results');
            if (maxResults) maxResults.value = String(config.maxResults || 8);

            const searchDelay = inputEl('settings-search-delay');
            if (searchDelay) searchDelay.value = String(config.searchDelay || 120);

            const placeholderText = inputEl('settings-placeholder-text');
            if (placeholderText) placeholderText.value = config.placeholderText || '';

            const showPlaceholder = inputEl('settings-show-placeholder');
            if (showPlaceholder) showPlaceholder.checked = config.showPlaceholder !== false;

            // Appearance tab
            const theme = selectEl('settings-theme');
            if (theme) theme.value = config.theme || 'dark';

            const useAnimation = inputEl('settings-use-animation');
            if (useAnimation) useAnimation.checked = config.useAnimation !== false;

            // System tab
            const startOnStartup = inputEl('settings-start-on-startup');
            if (startOnStartup) startOnStartup.checked = startupEnabled;

            const hideNotifyIcon = inputEl('settings-hide-notify-icon');
            if (hideNotifyIcon) hideNotifyIcon.checked = !!config.hideNotifyIcon;

            // Updates tab
            const versionEl = document.getElementById('settings-version');
            if (versionEl) versionEl.textContent = `v${version}`;

            // Misc tab — populate dirs lazily
            GetDataDir().then(d => {
                const el = document.getElementById('misc-data-dir');
                if (el) el.textContent = d;
            }).catch(() => {});
            GetInstallDir().then(d => {
                const el = document.getElementById('misc-install-dir');
                if (el) el.textContent = d;
            }).catch(() => {});

            const indexStatus = document.getElementById('settings-index-status');
            if (indexStatus) {
                const s = this.activeNotifs.get('indexing');
                indexStatus.textContent = s ? s.title + ' ' + s.subtitle : '—';
            }

            this._currentIndexDirs = config.indexDirs || [];
            this._renderIndexDirs();
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    }

    _activateSettingsTab(name: string): void {
        document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach(btn => {
            btn.classList.toggle('active', btn.dataset['tab'] === name);
        });
        document.querySelectorAll('.settings-tab').forEach(tab => {
            tab.classList.toggle('hidden', tab.id !== `tab-${name}`);
        });
    }

    closeSettings(): void {
        if (this.settingsMode) {
            CloseSettings();
            return;
        }
        this.settingsPanelEl.classList.add('hidden');
        this.searchInput.focus();
    }

    bindSettings(): void {
        document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach(btn => {
            btn.addEventListener('click', () => this._activateSettingsTab(btn.dataset['tab'] ?? ''));
        });

        const closeBtn = document.getElementById('settings-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.closeSettings());

        const cancelBtn = document.getElementById('settings-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeSettings());

        const saveBtn = document.getElementById('settings-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                const cfg = {
                    firstRun: false,
                    hotkey: document.getElementById('settings-hotkey-display')?.textContent || 'Alt+Space',
                    maxClipboard: parseInt(inputEl('settings-clipboard-size')?.value || '50', 10),
                    lastQueryMode: selectEl('settings-last-query-mode')?.value || 'clear',
                    hideWhenDeactivated: inputEl('settings-hide-deactivated')?.checked ?? true,
                    windowPosition: selectEl('settings-window-position')?.value || 'center',
                    maxResults: parseInt(inputEl('settings-max-results')?.value || '8', 10),
                    searchDelay: parseInt(inputEl('settings-search-delay')?.value || '120', 10),
                    placeholderText: inputEl('settings-placeholder-text')?.value || '',
                    showPlaceholder: inputEl('settings-show-placeholder')?.checked ?? true,
                    theme: selectEl('settings-theme')?.value || 'dark',
                    useAnimation: inputEl('settings-use-animation')?.checked ?? true,
                    startOnStartup: inputEl('settings-start-on-startup')?.checked ?? false,
                    hideNotifyIcon: inputEl('settings-hide-notify-icon')?.checked ?? false,
                    indexDirs: this._currentIndexDirs,
                };
                try {
                    const cfgObj = main.BlightConfig.createFrom(cfg);
                    await SaveSettings(cfgObj);
                    this._applyRuntimeSettings(cfgObj);
                    if (this.settingsMode) {
                        CloseSettings();
                        return;
                    }
                    this.showToast('Settings saved', 'Changes applied');
                    this.closeSettings();
                } catch (e) {
                    this.showToast('Save failed', String(e));
                }
            });
        }

        const reindexBtn = document.getElementById('settings-reindex');
        const cancelIndexBtn = document.getElementById('settings-cancel-index');
        if (reindexBtn) {
            reindexBtn.addEventListener('click', async () => {
                await ReindexFiles();
                const statusEl = document.getElementById('settings-index-status');
                if (statusEl) statusEl.textContent = 'Reindexing…';
            });
        }
        if (cancelIndexBtn) {
            cancelIndexBtn.addEventListener('click', () => {
                CancelIndex();
            });
        }

        const clearBtn = document.getElementById('settings-clear-index');
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                await ClearIndex();
                const statusEl = document.getElementById('settings-index-status');
                if (statusEl) statusEl.textContent = 'Index cleared';
                this.showToast('Index cleared', '');
            });
        }

        const checkUpdatesBtn = document.getElementById('settings-check-updates') as HTMLButtonElement | null;
        const updateStatus = document.getElementById('settings-update-status');
        if (checkUpdatesBtn) {
            checkUpdatesBtn.addEventListener('click', async () => {
                const cooldown = 10000;
                const elapsed = Date.now() - this.lastUpdateCheck;
                if (elapsed < cooldown) {
                    const remaining = Math.ceil((cooldown - elapsed) / 1000);
                    if (updateStatus) {
                        updateStatus.textContent = `Please wait ${remaining}s before checking again`;
                        updateStatus.className = 'settings-update-status error';
                    }
                    return;
                }
                this.lastUpdateCheck = Date.now();
                checkUpdatesBtn.disabled = true;
                checkUpdatesBtn.textContent = 'Checking…';
                if (updateStatus) { updateStatus.textContent = ''; updateStatus.className = 'settings-update-status'; }
                try {
                    const update = await CheckForUpdates();
                    if (update && update.available) {
                        if (updateStatus) {
                            updateStatus.textContent = `v${update.version} available — click badge in footer to install`;
                            updateStatus.className = 'settings-update-status success';
                        }
                        this.showUpdateUI(update);
                    } else if (update && update.error) {
                        if (updateStatus) {
                            updateStatus.textContent = update.error;
                            updateStatus.className = 'settings-update-status error';
                        }
                    } else {
                        if (updateStatus) {
                            updateStatus.textContent = 'You\'re on the latest version';
                            updateStatus.className = 'settings-update-status';
                        }
                    }
                } catch (e) {
                    if (updateStatus) {
                        updateStatus.textContent = String(e);
                        updateStatus.className = 'settings-update-status error';
                    }
                } finally {
                    checkUpdatesBtn.disabled = false;
                    checkUpdatesBtn.textContent = 'Check for Updates';
                }
            });
        }

        const addDirBtn = document.getElementById('settings-add-dir');
        if (addDirBtn) {
            addDirBtn.addEventListener('click', async () => {
                const dir = await OpenFolderPicker();
                if (dir) {
                    this._currentIndexDirs = [...this._currentIndexDirs, dir];
                    this._renderIndexDirs();
                }
            });
        }

        EventsOn('indexStatus', (status: files.IndexStatus) => {
            const statusEl = document.getElementById('settings-index-status');
            if (statusEl) statusEl.textContent = status.message;
            const reindexBtn = document.getElementById('settings-reindex') as HTMLButtonElement | null;
            const cancelBtn = document.getElementById('settings-cancel-index');
            const indexing = status.state === 'indexing';
            if (reindexBtn) reindexBtn.disabled = indexing;
            if (cancelBtn) cancelBtn.classList.toggle('hidden', !indexing);
        });

        // Misc tab
        const miscOpenData = document.getElementById('misc-open-data');
        const miscOpenInstall = document.getElementById('misc-open-install');
        const miscUninstall = document.getElementById('misc-uninstall');

        if (miscOpenData) {
            miscOpenData.addEventListener('click', async () => {
                const dir = await GetInstallDir();
                OpenFolder(dir);
            });
        }
        if (miscOpenInstall) {
            miscOpenInstall.addEventListener('click', async () => {
                const dir = await GetInstallDir();
                OpenFolder(dir);
            });
        }
        if (miscUninstall) {
            miscUninstall.addEventListener('click', () => {
                this.showConfirmModal(
                    'Uninstall blight?',
                    'This will permanently remove blight from your system. Your config and data in .blight will not be deleted.',
                    'Uninstall',
                    true,
                    async () => {
                        const res = await Uninstall();
                        if (res !== 'success') {
                            this.showToast('Uninstall failed', res.replace('not-found:', 'Uninstaller not found: ').replace('error:', ''));
                        }
                    }
                );
            });
        }
    }

    _renderIndexDirs(): void {
        const container = document.getElementById('settings-index-dirs');
        if (!container) return;
        const dirs = this._currentIndexDirs;
        if (dirs.length === 0) {
            container.innerHTML = '<div style="font-size:11px;color:var(--text-tertiary)">No extra directories added</div>';
            return;
        }
        container.innerHTML = dirs.map((d, i) => `
            <div class="settings-dir-item">
                <span class="settings-dir-path">${this.escapeHtml(d)}</span>
                <button class="settings-dir-remove" data-index="${i}">✕</button>
            </div>
        `).join('');
        container.querySelectorAll<HTMLElement>('.settings-dir-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset['index'] ?? '0', 10);
                this._currentIndexDirs = this._currentIndexDirs.filter((_, i) => i !== idx);
                this._renderIndexDirs();
            });
        });
    }

    // --- Fallback Icons ---

    getFallbackIcon(category: string): string {
        const c = (category || '').toLowerCase();
        if (c === 'applications' || c === 'recent' || c === 'suggested') {
            return `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="2" width="20" height="20" rx="5" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <rect x="5" y="5" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.2)"/>
                <rect x="13" y="5" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.15)"/>
                <rect x="5" y="13" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.15)"/>
                <rect x="13" y="13" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.1)"/>
            </svg>`;
        }
        if (c === 'files') {
            return `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M6 2C4.9 2 4 2.9 4 4v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6z" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <path d="M14 2v6h6" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <line x1="8" y1="13" x2="16" y2="13" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <line x1="8" y1="16" x2="14" y2="16" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
            </svg>`;
        }
        if (c === 'web') {
            return `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.15)" stroke-width="1" fill="rgba(255,255,255,0.05)"/>
                <path d="M12 3c0 0-3 3.5-3 9s3 9 3 9" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
                <path d="M12 3c0 0 3 3.5 3 9s-3 9-3 9" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
                <line x1="3" y1="12" x2="21" y2="12" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
                <circle cx="17" cy="17" r="4" fill="#1e1e1e" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <line x1="20" y1="20" x2="22" y2="22" stroke="rgba(255,255,255,0.2)" stroke-width="1.5" stroke-linecap="round"/>
            </svg>`;
        }
        if (c === 'system') {
            return `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
            </svg>`;
        }
        if (c === 'calculator') {
            return `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="4" y="2" width="16" height="20" rx="3" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <rect x="7" y="5" width="10" height="4" rx="1" fill="rgba(255,255,255,0.1)"/>
                <rect x="7" y="12" width="3" height="2" rx="0.5" fill="rgba(255,255,255,0.15)"/>
                <rect x="10.5" y="12" width="3" height="2" rx="0.5" fill="rgba(255,255,255,0.15)"/>
                <rect x="14" y="12" width="3" height="2" rx="0.5" fill="rgba(255,255,255,0.2)"/>
                <rect x="7" y="16" width="3" height="2" rx="0.5" fill="rgba(255,255,255,0.15)"/>
                <rect x="10.5" y="16" width="3" height="2" rx="0.5" fill="rgba(255,255,255,0.15)"/>
                <rect x="14" y="16" width="3" height="4" rx="0.5" fill="rgba(92,154,255,0.3)"/>
            </svg>`;
        }
        if (c === 'clipboard') {
            return `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" stroke="rgba(255,255,255,0.2)" stroke-width="1" fill="rgba(255,255,255,0.05)"/>
                <rect x="8" y="2" width="8" height="4" rx="1.5" stroke="rgba(255,255,255,0.2)" stroke-width="1" fill="rgba(255,255,255,0.08)"/>
                <line x1="8" y1="11" x2="16" y2="11" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <line x1="8" y1="14" x2="14" y2="14" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
            </svg>`;
        }
        return `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="12" cy="12" r="9" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
            <circle cx="12" cy="12" r="3" fill="rgba(255,255,255,0.15)"/>
        </svg>`;
    }

    // --- Toast ---

    showToast(message: string, detail = ''): void {
        const brand = document.getElementById('footer-brand');
        const toastEl = document.getElementById('footer-toast');
        if (!brand || !toastEl) return;

        brand.classList.add('hidden-by-toast');
        toastEl.textContent = message;
        toastEl.classList.add('visible');

        this.toastHovered = false;

        toastEl.onmouseenter = () => {
            this.toastHovered = true;
            clearTimeout(this.toastTimer ?? undefined);
        };

        toastEl.onmouseleave = () => {
            this.toastHovered = false;
            this.startToastDismiss(brand, toastEl);
        };

        clearTimeout(this.toastTimer ?? undefined);
        this.startToastDismiss(brand, toastEl);
    }

    startToastDismiss(brand: HTMLElement, toastEl: HTMLElement): void {
        this.toastTimer = setTimeout(() => {
            if (this.toastHovered) return;
            toastEl.classList.remove('visible');
            brand.classList.remove('hidden-by-toast');
        }, 5000);
    }

    // --- System Notifications (pinned top of results) ---

    listenIndexStatus(): void {
        EventsOn('indexStatus', (status: files.IndexStatus) => {
            if (status.state === 'indexing') {
                const sub = status.count > 0
                    ? `${status.count.toLocaleString()} files scanned`
                    : status.message;
                this.activeNotifs.set('indexing', { icon: '⏳', title: 'Indexing files…', subtitle: sub });
            } else {
                this.activeNotifs.delete('indexing');
            }
            this._refreshSystemNotifs();
        });
    }

    _refreshSystemNotifs(): void {
        if (this.launcherEl.classList.contains('spotlight-mode')) return;

        const existing = document.getElementById('system-notifs-section');

        if (this.activeNotifs.size === 0) {
            existing?.remove();
            return;
        }

        let inner = `<div class="result-category">Notification</div>`;
        for (const [id, n] of this.activeNotifs) {
            inner += `<div class="result-item notif-result-item" data-notif-id="${this.escapeHtml(id)}" style="${n.action ? 'cursor:pointer' : ''}">
                <div class="result-icon-fallback">${n.icon}</div>
                <div class="result-text">
                    <div class="result-title">${this.escapeHtml(n.title)}</div>
                    ${n.subtitle ? `<div class="result-subtitle">${this.escapeHtml(n.subtitle)}</div>` : ''}
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

        this.resultsContainer.querySelectorAll<HTMLElement>('[data-notif-id]').forEach(el => {
            const notif = this.activeNotifs.get(el.dataset['notifId']!);
            if (notif?.action) el.addEventListener('click', notif.action, { once: true });
        });
    }
}

document.addEventListener('DOMContentLoaded', () => new Blight());
