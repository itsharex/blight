/* eslint-disable no-console */
import {
    IsFirstRun,
    IsSettingsMode,
    Search,
    Execute,
    HideWindow,
    ExecuteContextAction,
    CheckForUpdates,
    InstallUpdate,
    GetIcon,
    GetConfig,
    GetVersion,
    GetUsageScores,
} from '../wailsjs/go/main/App';
import {
    provideFluentDesignSystem,
    fluentButton,
    fluentSwitch,
    fluentSelect,
    fluentOption,
    fluentTextField,
    baseLayerLuminance,
    StandardLuminance,
    accentBaseColor,
    SwatchRGB,
} from '@fluentui/web-components';
import { EventsOn } from '../wailsjs/runtime/runtime';
import { main, files } from '../wailsjs/go/models';

import { escapeHtml, highlightMatch } from './modules/utils';
import { getFallbackIcon } from './modules/icons';
import { showConfirmModal } from './modules/modal';
import { Toast, ToastType } from './modules/toast';
import { Splash } from './modules/splash';
import { ContextMenu } from './modules/context-menu';
import { Settings } from './modules/settings';
import { SearchHistory } from './modules/search-history';
import { CalcPreview } from './modules/calc-preview';
import { FilterPills } from './modules/filter-pills';
import { SystemNotifications } from './modules/system-notifs';

class Blight {
    // Search state
    private selectedIndex = 0;
    private results: main.SearchResult[] = [];
    private _displayResults: main.SearchResult[] = [];
    private searchSeq = 0;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private currentQuery = '';
    private activeFilter: string | null = null;
    private searchDelay = 120;

    // Settings / config
    private settingsMode = false;
    private hideWhenDeactivated = true;
    private lastQueryMode = 'clear';
    private lastUpdateCheck = 0;

    // Window state
    private lastShownAt = 0;
    private isHiding = false;

    // Icon cache
    private iconCache: Map<string, string> = new Map();
    private renderSeq = 0;

    // Usage scores for frequency dots
    private usageScores: Map<string, number> = new Map();

    // What's New
    private lastKnownVersion: string | null = localStorage.getItem('blight-last-version');

    // DOM elements
    private searchInput: HTMLInputElement;
    private resultsContainer: HTMLElement;
    private splashEl: HTMLElement;
    private launcherEl: HTMLElement;
    private settingsPanelEl: HTMLElement;

    // Modules
    private toast: Toast;
    private splash: Splash;
    private contextMenu: ContextMenu;
    private settings: Settings;
    private searchHistory: SearchHistory;
    private calcPreview: CalcPreview;
    private filterPills: FilterPills;
    private systemNotifs: SystemNotifications;

    constructor() {
        this.searchInput = document.getElementById('search-input') as HTMLInputElement;
        this.resultsContainer = document.getElementById('results')!;
        this.splashEl = document.getElementById('splash')!;
        this.launcherEl = document.getElementById('app')!;
        this.settingsPanelEl = document.getElementById('settings-panel')!;

        const brandEl = document.getElementById('footer-brand')!;
        const toastEl = document.getElementById('footer-toast')!;
        this.toast = new Toast(brandEl, toastEl);

        this.splash = new Splash(this.splashEl, this.launcherEl, () => this.showLauncher());

        this.contextMenu = new ContextMenu(
            document.getElementById('context-menu')!,
            (actionId, response, title) => this.handleContextResponse(actionId, response, title)
        );

        this.settings = new Settings(this.settingsPanelEl, {
            showToast: (msg, detail?, type?) => this.showToast(msg, detail, type),
            applyRuntimeSettings: (cfg) => this._applyRuntimeSettings(cfg),
            onClose: () => this.searchInput.focus(),
            settingsMode: false, // updated after init
            getLastUpdateCheck: () => this.lastUpdateCheck,
            setLastUpdateCheck: (t) => {
                this.lastUpdateCheck = t;
            },
            onUpdateAvailable: (update) => this.showUpdateUI(update),
        });

        this.searchHistory = new SearchHistory(
            document.getElementById('search-history')!,
            this.searchInput,
            () => this.onSearchInput()
        );

        this.calcPreview = new CalcPreview(document.getElementById('calc-preview')!);

        this.filterPills = new FilterPills(
            document.getElementById('search-filter-pills')!,
            (filter) => {
                this.activeFilter = filter;
                if (this.currentQuery) {
                    this.filterPills.render(filter);
                    this.renderResults();
                } else {
                    // No query — show only the active badge or hide
                    if (filter) {
                        this.filterPills.renderActiveOnly();
                    } else {
                        this.filterPills.hide();
                    }
                }
            }
        );

        this.systemNotifs = new SystemNotifications(this.resultsContainer, () =>
            this.launcherEl.classList.contains('spotlight-mode')
        );

        this.init();
    }

    // --- Init ---

    async init(): Promise<void> {
        // Detect OS and apply platform attribute for native-feel theming.
        // WebView2 UA contains "Windows NT"; WebKit on macOS contains "Macintosh".
        const ua = navigator.userAgent;
        const os = /Win/i.test(ua) ? 'windows' : /Mac/i.test(ua) ? 'darwin' : 'linux';
        document.documentElement.dataset.os = os;

        // Initialise the Fluent design system with dark/light mode and accent.
        // These two tokens drive ALL component colors — no manual color overrides needed.
        baseLayerLuminance.withDefault(
            window.matchMedia('(prefers-color-scheme: light)').matches
                ? StandardLuminance.LightMode
                : StandardLuminance.DarkMode
        );
        // Blight accent: #5C9AFF  → r=0.361 g=0.604 b=1.0
        accentBaseColor.withDefault(SwatchRGB.create(0.361, 0.604, 1.0));

        provideFluentDesignSystem().register(
            fluentButton(),
            fluentSwitch(),
            fluentSelect(),
            fluentOption(),
            fluentTextField()
        );

        const settingsMode = await IsSettingsMode();
        if (settingsMode) {
            this.settingsMode = true;
            // Patch settings module with settingsMode=true
            (this.settings as any).deps.settingsMode = true;
            document.body.classList.add('settings-only');
            this.settings.bind();
            this.settings.open();
            return;
        }

        try {
            const config = await GetConfig();
            this._applyRuntimeSettings(config);
        } catch (e) {
            console.error('Failed to load config on init:', e);
        }

        const firstRun = await IsFirstRun();
        if (firstRun) {
            this.splash.show();
        } else {
            this.showLauncher();
        }

        this.checkForUpdates();
    }

    // --- Launcher / Splash ---

    showLauncher(): void {
        this.splashEl.classList.add('hidden');
        this.launcherEl.classList.remove('hidden');
        setTimeout(() => this.searchInput.focus(), 50);
        this.bindEvents();
        this.listenIndexStatus();
        this.settings.bind();
        this.loadDefaultResults();
        this.loadUsageScores();
        this.filterPills.hide();
        this.checkWhatsNew();
    }

    // --- Updates ---

    async checkForUpdates(): Promise<void> {
        try {
            const update = await CheckForUpdates();
            if (update?.available) this.showUpdateUI(update);
        } catch (e) {
            console.error('Failed to check for updates:', e);
        }
    }

    showUpdateUI(update: main.UpdateInfo): void {
        this.systemNotifs.set('update', {
            icon: '⬇',
            title: `Update v${update.version} available`,
            subtitle: 'Click to install',
            action: () => this.installUpdate(update),
        });
        this.systemNotifs.refresh();
        this.settings.showUpdateInstallRow(update, () => this.installUpdate(update));
    }

    async installUpdate(update: main.UpdateInfo): Promise<void> {
        showConfirmModal(
            `Install update ${update.version}?`,
            'The installer will close and restart blight automatically.',
            'Install',
            false,
            async () => {
                this.settings.activateTab('updates');
                this.settingsPanelEl.classList.remove('hidden');

                const progressArea = document.getElementById('settings-update-progress-area');
                const bar = document.getElementById('settings-update-progress-bar');
                const fill = document.getElementById(
                    'settings-update-progress-fill'
                ) as HTMLElement | null;
                const text = document.getElementById('settings-update-progress-text');
                if (progressArea) progressArea.style.display = 'block';
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
                    this.showToast('Update failed', res, 'error');
                }
            }
        );
    }

    // --- Config application ---

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

    // --- Events ---

    bindEvents(): void {
        this.searchInput.addEventListener('input', () => this.onSearchInput());
        this.searchInput.addEventListener('focus', () => {
            if (!this.searchInput.value.trim()) this.searchHistory.show();
        });
        this.searchInput.addEventListener('blur', () => {
            setTimeout(() => this.searchHistory.hide(), 150);
        });

        document.addEventListener('keydown', (e) => {
            if (this.settings.isOpen) {
                if (e.key === 'Escape') {
                    this.settings.close();
                    e.preventDefault();
                }
                return;
            }
            if (this.contextMenu.isVisible) {
                this.contextMenu.handleKeydown(e);
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
                    if (e.ctrlKey) this.executeSecondaryAction();
                    else this.executeSelected();
                    break;
                case 'k':
                case 'K':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        this.openActionPanelForSelected();
                    }
                    break;
                case ',':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        this.settings.open();
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    this.searchHistory.hide();
                    if (this.activeFilter) {
                        this.activeFilter = null;
                        this.filterPills.clearFilter();
                        this.filterPills.hide();
                        this.renderResults();
                    } else if (this.searchInput.value) {
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
            if (
                e.target instanceof Node &&
                !document.getElementById('context-menu')!.contains(e.target)
            ) {
                this.contextMenu.hide();
            }
        });

        document
            .getElementById('settings-open-btn')
            ?.addEventListener('click', () => this.settings.open());

        this.lastShownAt = Date.now();
        this.isHiding = false;

        EventsOn('windowShown', () => {
            this.lastShownAt = Date.now();
            this.isHiding = false;
            this.searchHistory.hide();
            if (this.lastQueryMode !== 'preserve') {
                this.searchInput.value = '';
                this.currentQuery = '';
                this._displayResults = [];
                this.loadDefaultResults();
                this.activeFilter = null;
                this.filterPills.clearFilter();
                this.filterPills.hide();
            }
            setTimeout(() => {
                this.searchInput.focus();
                this.searchInput.select();
            }, 30);
        });

        window.addEventListener('blur', () => {
            if (!this.hideWhenDeactivated || this.isHiding) return;
            if (Date.now() - this.lastShownAt < 600) return;
            this.isHiding = true;
            HideWindow();
        });

        EventsOn('openSettings', () => this.settings.open());
    }

    // --- Search ---

    onSearchInput(): void {
        clearTimeout(this.debounceTimer ?? undefined);
        const query = this.searchInput.value.trim();
        if (!query) {
            this.setLoading(false);
            this.loadDefaultResults();
            this.calcPreview.clear();
            this.searchHistory.show();
            // Clear active filter and hide pills when query is emptied
            this.activeFilter = null;
            this.filterPills.clearFilter();
            this.filterPills.hide();
            return;
        }
        this.searchHistory.hide();
        this.launcherEl.classList.remove('spotlight-mode');
        this.setLoading(true);
        this.calcPreview.update(query);
        // Show filter pills once the user starts typing
        this.filterPills.render(this.activeFilter);
        this.debounceTimer = setTimeout(async () => {
            const seq = ++this.searchSeq;
            const results = await Search(query);
            this.setLoading(false);
            if (seq !== this.searchSeq) return;
            this.currentQuery = query;
            this.results = results;
            this._displayResults = [];
            this.selectedIndex = 0;
            this.renderResults();
        }, this.searchDelay);
    }

    loadDefaultResults(): void {
        this.searchSeq++;
        this.currentQuery = '';
        this.results = [];
        this._displayResults = [];
        this.selectedIndex = 0;
        this.resultsContainer.innerHTML = '';
        this.launcherEl.classList.add('spotlight-mode');
        this.updateFooterHints(null);
        this.calcPreview.clear();
    }

    setLoading(loading: boolean): void {
        document.getElementById('search-loader')?.classList.toggle('visible', loading);
    }

    // --- Results rendering ---

    renderResults(): void {
        const renderSeq = ++this.renderSeq;
        this.launcherEl.classList.remove('spotlight-mode');

        if (this.results.length === 0) {
            const q = this.currentQuery;
            let emptyMsg = 'No results found';
            let emptyAction = '';
            if (q.length >= 2) {
                emptyMsg = `Nothing matching "${q}"`;
                emptyAction = `<div class="no-results-action" id="no-results-web">Search the web instead</div>`;
            }
            this.resultsContainer.innerHTML = `
                <div class="no-results">
                    <div style="font-size: 24px; opacity: 0.3;">⌕</div>
                    <div>${escapeHtml(emptyMsg)}</div>
                    ${emptyAction}
                </div>
            `;
            document.getElementById('no-results-web')?.addEventListener('click', () => {
                Execute('web-search:' + q);
            });
            this.updateFooterHints(null);
            return;
        }

        const filtered = this.activeFilter
            ? this.results.filter(
                  (r) => r.category.toLowerCase() === this.activeFilter!.toLowerCase()
              )
            : this.results;

        if (filtered.length === 0 && this.activeFilter) {
            this.resultsContainer.innerHTML = `
                <div class="no-results">
                    <div style="font-size: 24px; opacity: 0.3;">⌕</div>
                    <div>No ${this.activeFilter} results</div>
                </div>
            `;
            this.updateFooterHints(null);
            return;
        }

        const displayResults = filtered.length > 0 ? filtered : this.results;
        let html = '';
        let lastCategory = '';

        displayResults.forEach((result, index) => {
            if (result.category !== lastCategory) {
                html += `<div class="result-category">${escapeHtml(result.category)}</div>`;
                lastCategory = result.category;
            }

            const selected = index === this.selectedIndex ? 'selected' : '';
            const cachedIcon = result.path ? this.iconCache.get(result.path) : null;
            const iconSrc =
                result.icon && result.icon.startsWith('data:') ? result.icon : cachedIcon;
            const iconHtml = iconSrc
                ? `<div class="result-icon"><img src="${iconSrc}" alt=""/></div>`
                : `<div class="result-icon result-icon-fallback" data-icon-index="${index}">${getFallbackIcon(result.category)}</div>`;

            const titleHtml = highlightMatch(result.title, this.currentQuery);

            const freq = this.usageScores.get(result.id) ?? 0;
            const freqDot =
                freq > 0
                    ? `<div class="result-freq-dot ${freq > 300 ? 'freq-high' : freq > 100 ? 'freq-med' : 'freq-low'}" title="Used frequently"></div>`
                    : '';

            const pinBadge =
                result.category === 'Pinned'
                    ? `<span class="result-pin-badge" title="Pinned">📌</span>`
                    : '';

            html += `
                <div class="result-item ${selected}" data-index="${index}" data-id="${result.id}" role="option" aria-selected="${index === this.selectedIndex}">
                    ${iconHtml}
                    <div class="result-text">
                        <div class="result-title">${titleHtml}</div>
                        <div class="result-subtitle">${escapeHtml(result.subtitle)}</div>
                    </div>
                    ${pinBadge}${freqDot}
                    <div class="result-badge">${escapeHtml(result.category)}</div>
                </div>
            `;
        });

        this.resultsContainer.innerHTML = html;

        this.resultsContainer.querySelectorAll<HTMLElement>('.result-item').forEach((item) => {
            item.addEventListener('click', () => {
                this.selectedIndex = parseInt(item.dataset['index'] ?? '0', 10);
                this.executeSelected();
            });
            item.addEventListener('mouseenter', () => {
                this.resultsContainer
                    .querySelector('.result-item.selected')
                    ?.classList.remove('selected');
                item.classList.add('selected');
                this.selectedIndex = parseInt(item.dataset['index'] ?? '0', 10);
                this.updateFooterHints(displayResults[this.selectedIndex] ?? null);
            });
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.resultsContainer
                    .querySelector('.result-item.selected')
                    ?.classList.remove('selected');
                item.classList.add('selected');
                this.selectedIndex = parseInt(item.dataset['index'] ?? '0', 10);
                this.contextMenu.show(
                    e.clientX,
                    e.clientY,
                    item.dataset['id'] ?? '',
                    item.querySelector('.result-title')?.textContent ?? '',
                    false
                );
            });
        });

        displayResults.forEach((result, index) => {
            if (!result.path || this.iconCache.has(result.path)) return;
            if (result.icon && result.icon.startsWith('data:')) return;
            GetIcon(result.path)
                .then((icon) => {
                    if (!icon || this.renderSeq !== renderSeq) return;
                    this.iconCache.set(result.path, icon);
                    const el = this.resultsContainer.querySelector(`[data-icon-index="${index}"]`);
                    if (el)
                        el.outerHTML = `<div class="result-icon"><img src="${icon}" alt=""/></div>`;
                })
                .catch(() => {});
        });

        this._displayResults = displayResults;
        this.updateFooterHints(this._displayResults[this.selectedIndex] ?? null);
        this.systemNotifs.refresh();
    }

    // --- Navigation ---

    moveSelection(delta: number): void {
        const list = this._displayResults.length > 0 ? this._displayResults : this.results;
        if (list.length === 0) return;
        const items = this.resultsContainer.querySelectorAll<HTMLElement>('.result-item');
        // Guard: DOM might not match list if a re-render is in flight
        if (items.length === 0 || items.length !== list.length) return;

        // Remove selected from current item
        items[this.selectedIndex]?.classList.remove('selected');
        items[this.selectedIndex]?.setAttribute('aria-selected', 'false');

        this.selectedIndex = (this.selectedIndex + delta + list.length) % list.length;

        const next = items[this.selectedIndex];
        if (next) {
            next.classList.add('selected');
            next.setAttribute('aria-selected', 'true');
            this._scrollItemIntoView(next);
        }

        // Suppress CSS :hover while keyboard-navigating; re-enable on mouse move
        this.resultsContainer.classList.add('keyboard-nav');

        this.updateFooterHints(list[this.selectedIndex] ?? null);
    }

    /** Scroll the item into view without smooth animation (avoids queued-scroll
     *  jumps when the user holds down an arrow key). */
    private _scrollItemIntoView(item: HTMLElement): void {
        const container = this.resultsContainer;
        const containerTop = container.scrollTop;
        const containerBottom = containerTop + container.clientHeight;
        const itemTop = item.offsetTop;
        const itemBottom = itemTop + item.offsetHeight;

        if (itemBottom > containerBottom) {
            container.scrollTop = itemBottom - container.clientHeight + 4;
        } else if (itemTop < containerTop) {
            container.scrollTop = itemTop - 4;
        }
    }

    async executeSelected(): Promise<void> {
        const list = this._displayResults.length > 0 ? this._displayResults : this.results;
        if (list.length === 0) return;
        const result = list[this.selectedIndex];

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
            this.showToast('Copied to clipboard', result.title, 'success');
        } else if (response === 'ok') {
            if (result.id.startsWith('sys-')) {
                this.showToast(result.title, result.subtitle, 'info');
            } else {
                this.showToast(`Launched ${result.title}`, result.path || '', 'success');
            }
        } else if (response && response !== 'ok' && response !== 'copied') {
            this.showToast('Action failed', response, 'error');
        }

        if (this.currentQuery) {
            this.searchHistory.add(this.currentQuery);
        }
    }

    async executeSecondaryAction(): Promise<void> {
        const list = this._displayResults.length > 0 ? this._displayResults : this.results;
        if (list.length === 0) return;
        const result = list[this.selectedIndex];
        const actionId = this.getSecondaryActionId(result.id);
        if (!actionId) return;
        const response = await ExecuteContextAction(result.id, actionId);
        this.handleContextResponse(actionId, response, result.title);
    }

    async openActionPanelForSelected(): Promise<void> {
        const list = this._displayResults.length > 0 ? this._displayResults : this.results;
        if (list.length === 0) return;
        const result = list[this.selectedIndex];
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
        await this.contextMenu.show(x, y, result.id, result.title, true);
    }

    getSecondaryActionId(resultId: string): string | null {
        if (resultId.startsWith('dir-open:')) return 'terminal';
        if (resultId.startsWith('file-open:')) return 'explorer';
        if (resultId.startsWith('clip-')) return 'copy';
        if (
            resultId.startsWith('sys-') ||
            resultId.startsWith('web-search:') ||
            resultId === 'calc-result'
        )
            return null;
        return 'admin';
    }

    getSecondaryActionLabel(resultId: string): string {
        if (resultId.startsWith('dir-open:')) return 'Open in Terminal';
        if (resultId.startsWith('file-open:')) return 'Show in Explorer';
        if (resultId.startsWith('clip-')) return 'Copy';
        return 'Run as Admin';
    }

    // --- Context response ---

    handleContextResponse(actionId: string, response: string, title: string): void {
        switch (actionId) {
            case 'copy-path':
                this.showToast('Path copied', title, 'success');
                break;
            case 'copy-name':
                this.showToast('Name copied', title, 'success');
                break;
            case 'copy':
                this.showToast('Copied to clipboard', title, 'success');
                break;
            case 'delete':
                this.showToast('Deleted', title, 'info');
                this.loadDefaultResults();
                break;
            case 'admin':
                if (response === 'ok') this.showToast('Launched as admin', title, 'success');
                else if (response && response !== 'ok') this.showToast('Failed', response, 'error');
                break;
            case 'open':
            case 'run':
                if (response === 'ok') this.showToast('Launched', title, 'success');
                break;
            case 'pin':
                if (response === 'pinned')
                    this.showToast(
                        `Pinned "${title}"`,
                        'Will appear at top of launcher',
                        'success'
                    );
                else this.showToast(`Unpinned "${title}"`, '', 'info');
                break;
            case 'delete-alias':
                this.showToast('Alias deleted', title, 'info');
                break;
        }
    }

    // --- Footer hints ---

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
            secondaryHint.innerHTML = `<kbd>Ctrl+↵</kbd> ${escapeHtml(secondaryLabel)}`;
            secondaryHint.classList.remove('hidden');
        } else {
            secondaryHint.classList.add('hidden');
        }
    }

    // --- Toast convenience ---

    showToast(message: string, detail = '', type: ToastType = 'info'): void {
        this.toast.show(message, detail, type);
    }

    // --- Index status ---

    listenIndexStatus(): void {
        EventsOn('indexStatus', (status: files.IndexStatus) => {
            if (status.state === 'indexing') {
                const sub =
                    status.count > 0
                        ? `${status.count.toLocaleString()} files scanned`
                        : status.message;
                this.systemNotifs.set('indexing', {
                    icon: '⏳',
                    title: 'Indexing files…',
                    subtitle: sub,
                });
            } else {
                this.systemNotifs.delete('indexing');
            }
            this.systemNotifs.refresh();
        });
    }

    // --- Usage scores ---

    async loadUsageScores(): Promise<void> {
        try {
            const scores = await GetUsageScores();
            this.usageScores = new Map(Object.entries(scores));
        } catch {
            /* non-critical */
        }
    }

    // --- What's New ---

    async checkWhatsNew(): Promise<void> {
        try {
            const version = await GetVersion();
            if (this.lastKnownVersion && this.lastKnownVersion !== version) {
                this._showWhatsNewBadge(version);
            }
            localStorage.setItem('blight-last-version', version);
            this.lastKnownVersion = version;
        } catch {
            /* non-critical */
        }
    }

    private _showWhatsNewBadge(version: string): void {
        const brand = document.getElementById('footer-brand');
        if (!brand) return;
        const badge = document.createElement('span');
        badge.id = 'whats-new-badge';
        badge.textContent = `New in ${version}`;
        badge.title = "blight was updated — click to see what's new";
        badge.addEventListener('click', () => {
            this.settings.activateTab('updates');
            this.settings.open();
            badge.remove();
        });
        brand.insertAdjacentElement('afterend', badge);
    }
}

document.addEventListener('DOMContentLoaded', () => new Blight());
