import {
    IsFirstRun, IsSettingsMode, CompleteOnboarding, Search, Execute, HideWindow,
    GetContextActions, ExecuteContextAction, CheckForUpdates, InstallUpdate,
    GetIcon, GetConfig, SaveSettings, GetVersion, ReindexFiles, ClearIndex,
    CloseSettings
} from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';

// Secondary action mapping: result id prefix → action id
const SECONDARY_ACTIONS = {
    'file-open:': 'explorer',  // Show in Explorer
    'clip-':      'copy',       // Copy clipboard entry
    'sys-':       'run',        // Run system command
    // Apps: determined at runtime (first non-open action)
};

class Blight {
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

        // Icon cache: path → base64 data URI (persists across re-renders)
        this.iconCache = new Map();
        this.renderSeq = 0;

        // Notification history
        this.notifications = [];

        this.searchInput = document.getElementById('search-input');
        this.resultsContainer = document.getElementById('results');
        this.splashEl = document.getElementById('splash');
        this.launcherEl = document.getElementById('app');
        this.contextMenuEl = document.getElementById('context-menu');
        this.settingsPanelEl = document.getElementById('settings-panel');

        // Notification elements
        this.notifIndicator = document.getElementById('notification-indicator');
        this.notifIcon = document.getElementById('notif-icon');
        this.notifText = document.getElementById('notif-text');
        this.notifHistory = document.getElementById('notification-history');
        this.notifHistoryList = document.getElementById('notif-history-list');
        this.notifClear = document.getElementById('notif-clear');

        this.init();
    }

    async init() {
        const settingsMode = await IsSettingsMode();
        if (settingsMode) {
            this.settingsMode = true;
            document.body.classList.add('settings-only');
            // Bind settings handlers without showing the launcher UI
            this.bindSettings();
            this.openSettings();
            return;
        }
        this.checkForUpdates();
        const firstRun = await IsFirstRun();
        if (firstRun) {
            this.showSplash();
        } else {
            this.showLauncher();
        }
    }

    async checkForUpdates() {
        try {
            const update = await CheckForUpdates();
            if (update && update.available) {
                this.showUpdateUI(update);
            }
        } catch (e) {
            console.error('Failed to check for updates:', e);
        }
    }

    showUpdateUI(update) {
        const existing = document.querySelector('.update-badge');
        if (existing) existing.remove();

        const badge = document.createElement('div');
        badge.className = 'notification-indicator update-badge';
        badge.innerHTML = `
            <span class="notif-icon" style="color: #4ade80;">⬇</span>
            <span class="notif-text" style="color: #4ade80;">Update ${update.version}</span>
        `;
        badge.style.cursor = 'pointer';
        badge.title = `Click to install update ${update.version}`;
        badge.onclick = () => this.installUpdate(update);

        if (this.notifIndicator && this.notifIndicator.parentNode) {
            this.notifIndicator.parentNode.insertBefore(badge, this.notifIndicator);
        }
    }

    async installUpdate(update) {
        if (!confirm(`Install update ${update.version}?\nThe installer will close and restart blight automatically.`)) return;

        this.showToast('Downloading update…', 'Please wait');
        const res = await InstallUpdate();
        if (res === 'success') {
            this.showToast('Installing…', 'blight will restart shortly');
        } else {
            this.showToast('Update failed', res);
        }
    }

    showSplash() {
        this.splashEl.classList.remove('hidden');
        this.launcherEl.classList.add('hidden');
        this.initSplash();
    }

    showLauncher() {
        this.splashEl.classList.add('hidden');
        this.launcherEl.classList.remove('hidden');
        setTimeout(() => this.searchInput.focus(), 50);
        this.bindEvents();
        this.listenIndexStatus();
        this.bindNotificationUI();
        this.bindSettings();
        this.loadDefaultResults();
    }

    // --- Splash ---

    initSplash() {
        this.currentSlide = 0;

        document.getElementById('splash-next').addEventListener('click', () => {
            if (this.currentSlide < 3) this.goToSlide(this.currentSlide + 1);
        });

        document.getElementById('splash-skip').addEventListener('click', () => this.completeSplash());
        document.getElementById('splash-go').addEventListener('click', () => this.completeSplash());

        document.querySelectorAll('.splash-dot').forEach(dot => {
            dot.addEventListener('click', () => this.goToSlide(parseInt(dot.dataset.dot)));
        });
    }

    goToSlide(index) {
        document.querySelectorAll('.splash-slide').forEach((slide, i) => {
            slide.classList.remove('active', 'exit-left');
            if (i < index) slide.classList.add('exit-left');
            if (i === index) slide.classList.add('active');
        });

        document.querySelectorAll('.splash-dot').forEach((dot, i) => {
            dot.classList.toggle('active', i === index);
        });

        document.getElementById('splash-next').style.visibility = index >= 3 ? 'hidden' : 'visible';
        this.currentSlide = index;
    }

    async completeSplash() {
        await CompleteOnboarding('Alt+Space');
        this.splashEl.style.animation = 'splashOut 250ms ease forwards';
        setTimeout(() => this.showLauncher(), 250);
    }

    // --- Events ---

    bindEvents() {
        this.searchInput.addEventListener('input', () => this.onSearchInput());

        document.addEventListener('keydown', (e) => {
            // Settings panel absorbs all keystrokes
            if (!this.settingsPanelEl.classList.contains('hidden')) {
                if (e.key === 'Escape') {
                    this.closeSettings();
                    e.preventDefault();
                }
                return;
            }

            // Context menu keyboard navigation
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
            if (!this.contextMenuEl.contains(e.target)) {
                this.hideContextMenu();
            }
            if (this.notifHistory && !this.notifIndicator.contains(e.target) && !this.notifHistory.contains(e.target)) {
                this.notifHistory.classList.add('hidden');
            }
        });

        // Settings open button in footer
        const settingsBtn = document.getElementById('settings-open-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => this.openSettings());
        }

        // Window show/hide lifecycle
        this.lastShownAt = Date.now(); // treat initial render as "just shown"
        this.isHiding = false;
        EventsOn('windowShown', () => {
            this.lastShownAt = Date.now();
            this.isHiding = false;
            // Reset to clean state on every show
            this.searchInput.value = '';
            this.currentQuery = '';
            this.loadDefaultResults();
            // Focus must be deferred slightly so the window is fully visible
            setTimeout(() => {
                this.searchInput.focus();
                this.searchInput.select();
            }, 30);
        });
        window.addEventListener('blur', () => {
            if (this.isHiding) return;
            if (Date.now() - this.lastShownAt < 600) return;
            if (!this.settingsPanelEl.classList.contains('hidden')) return;
            this.isHiding = true;
            HideWindow();
        });

        // Listen for openSettings event from tray
        EventsOn('openSettings', () => this.openSettings());
    }

    onSearchInput() {
        clearTimeout(this.debounceTimer);
        const query = this.searchInput.value.trim();
        if (!query) {
            this.setLoading(false);
            this.loadDefaultResults();
            return;
        }
        this.setLoading(true);
        this.debounceTimer = setTimeout(async () => {
            const seq = ++this.searchSeq;
            const results = await Search(query);
            this.setLoading(false);
            if (seq !== this.searchSeq) return; // ignore stale responses
            this.currentQuery = query;
            this.results = results;
            this.selectedIndex = 0;
            this.renderResults();
        }, 120);
    }

    loadDefaultResults() {
        this.searchSeq++; // cancel any in-flight search
        this.currentQuery = '';
        this.results = [];
        this.selectedIndex = 0;
        this.showEmptyState();
    }

    showEmptyState() {
        this.resultsContainer.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-hint">Search apps, files, and commands</div>
            </div>
        `;
        this.updateFooterHints(null);
    }

    setLoading(loading) {
        const loaderEl = document.getElementById('search-loader');
        if (loaderEl) loaderEl.classList.toggle('visible', loading);
    }

    moveSelection(delta) {
        if (this.results.length === 0) return;
        const items = this.resultsContainer.querySelectorAll('.result-item');
        if (items.length === 0) return;
        items[this.selectedIndex]?.classList.remove('selected');
        this.selectedIndex = (this.selectedIndex + delta + this.results.length) % this.results.length;
        const next = items[this.selectedIndex];
        if (next) {
            next.classList.add('selected');
            next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        this.updateFooterHints(this.results[this.selectedIndex] || null);
    }

    async executeSelected() {
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

    async executeSecondaryAction() {
        if (this.results.length === 0) return;
        const result = this.results[this.selectedIndex];
        const actionId = this.getSecondaryActionId(result.id);
        if (!actionId) return;

        const response = await ExecuteContextAction(result.id, actionId);
        this.handleContextResponse(actionId, response, result.title);
    }

    getSecondaryActionId(resultId) {
        if (resultId.startsWith('file-open:')) return 'explorer';
        if (resultId.startsWith('clip-')) return 'copy';
        if (resultId.startsWith('sys-')) return null; // no secondary for system
        if (resultId.startsWith('web-search:')) return null;
        if (resultId === 'calc-result') return null;
        // App → Run as Admin
        return 'admin';
    }

    getSecondaryActionLabel(resultId) {
        if (resultId.startsWith('file-open:')) return 'Show in Explorer';
        if (resultId.startsWith('clip-')) return 'Copy';
        return 'Run as Admin';
    }

    // --- Action Panel (Ctrl+K) ---

    async openActionPanelForSelected() {
        if (this.results.length === 0) return;
        const result = this.results[this.selectedIndex];
        const selectedEl = this.resultsContainer.querySelector('.result-item.selected');

        let x, y;
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

    renderResults() {
        const renderSeq = ++this.renderSeq;
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
            let iconHtml;
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

        this.resultsContainer.querySelectorAll('.result-item').forEach(item => {
            item.addEventListener('click', () => {
                this.selectedIndex = parseInt(item.dataset.index);
                this.executeSelected();
            });

            item.addEventListener('mouseenter', () => {
                const prev = this.resultsContainer.querySelector('.result-item.selected');
                if (prev && prev !== item) prev.classList.remove('selected');
                item.classList.add('selected');
                this.selectedIndex = parseInt(item.dataset.index);
                this.updateFooterHints(this.results[this.selectedIndex] || null);
            });

            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const prev = this.resultsContainer.querySelector('.result-item.selected');
                if (prev && prev !== item) prev.classList.remove('selected');
                item.classList.add('selected');
                this.selectedIndex = parseInt(item.dataset.index);
                this.showContextMenu(e.clientX, e.clientY, item.dataset.id, item.querySelector('.result-title')?.textContent || '', false);
            });
        });

        // Async icon loading
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

        // Update footer hints for selected item
        const selected = this.results[this.selectedIndex];
        this.updateFooterHints(selected || null);
    }

    // Update footer hints based on current selection
    updateFooterHints(result) {
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

    highlightMatch(text, query) {
        if (!query) return this.escapeHtml(text);

        const lowerText = text.toLowerCase();
        const lowerQuery = query.toLowerCase();

        // Substring match: highlight the whole matched substring
        const idx = lowerText.indexOf(lowerQuery);
        if (idx !== -1) {
            return this.escapeHtml(text.slice(0, idx)) +
                   `<span class="match-chars">${this.escapeHtml(text.slice(idx, idx + lowerQuery.length))}</span>` +
                   this.escapeHtml(text.slice(idx + lowerQuery.length));
        }

        // Fuzzy match: highlight individual matched characters
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

    escapeHtml(str) {
        if (typeof str !== 'string') return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // --- Context Menu ---

    async showContextMenu(x, y, resultId, resultTitle, fromKeyboard = false) {
        this.contextTarget = resultId;
        const actions = await GetContextActions(resultId);

        if (actions.length === 0) return;

        this.contextMenuActions = actions;
        this.contextMenuSelectedIndex = fromKeyboard ? 0 : -1;

        this.renderContextMenu(resultTitle, fromKeyboard);

        // Position with boundary clamping (measure after adding to DOM)
        this.contextMenuEl.style.left = '0px';
        this.contextMenuEl.style.top = '0px';
        const rect = this.contextMenuEl.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width - 8;
        const maxY = window.innerHeight - rect.height - 8;
        // Prefer placing to the left of x so it doesn't clip the right edge
        const targetX = Math.min(Math.max(x - rect.width, 8), maxX);
        const targetY = Math.min(Math.max(y, 8), maxY);
        this.contextMenuEl.style.left = `${targetX}px`;
        this.contextMenuEl.style.top = `${targetY}px`;
    }

    renderContextMenu(resultTitle, fromKeyboard) {
        const actions = this.contextMenuActions;
        let html = '';

        if (resultTitle) {
            html += `<div class="context-menu-header">${this.escapeHtml(resultTitle)}</div>`;
        }

        actions.forEach((action, idx) => {
            const isSelected = idx === this.contextMenuSelectedIndex;
            const kbClass = isSelected ? ' kb-selected' : '';

            // Show keyboard shortcut hint for first two actions
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

        this.contextMenuEl.querySelectorAll('.context-action').forEach(btn => {
            btn.addEventListener('click', async () => {
                const actionId = btn.dataset.action;
                const response = await ExecuteContextAction(this.contextTarget, actionId);
                this.hideContextMenu();
                this.handleContextResponse(actionId, response, resultTitle);
            });

            btn.addEventListener('mouseenter', () => {
                this.contextMenuSelectedIndex = parseInt(btn.dataset.idx);
                this.reRenderContextMenuSelection();
            });
        });
    }

    handleContextMenuKeydown(e) {
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
                if (this.contextMenuSelectedIndex >= 0) {
                    const action = actions[this.contextMenuSelectedIndex];
                    ExecuteContextAction(this.contextTarget, action.id).then(response => {
                        const resultTitle = this.results[this.selectedIndex]?.title || '';
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

    reRenderContextMenuSelection() {
        this.contextMenuEl.querySelectorAll('.context-action').forEach((btn, idx) => {
            btn.classList.toggle('kb-selected', idx === this.contextMenuSelectedIndex);
        });
    }

    handleContextResponse(actionId, response, title) {
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
                // no toast needed
                break;
        }
    }

    hideContextMenu() {
        this.contextMenuEl.classList.add('hidden');
        this.contextTarget = null;
        this.contextMenuSelectedIndex = -1;
        this.contextMenuActions = [];
    }

    // --- Settings Panel ---

    async openSettings() {
        this.settingsPanelEl.classList.remove('hidden');
        this.settingsPanelEl.style.animation = 'none';
        this.settingsPanelEl.offsetHeight; // force reflow
        this.settingsPanelEl.style.animation = '';

        try {
            const [config, version] = await Promise.all([GetConfig(), GetVersion()]);

            const hotkeyDisplay = document.getElementById('settings-hotkey-display');
            if (hotkeyDisplay) hotkeyDisplay.textContent = config.hotkey || 'Alt+Space';

            const clipSizeInput = document.getElementById('settings-clipboard-size');
            if (clipSizeInput) clipSizeInput.value = config.maxClipboard || 50;

            const versionEl = document.getElementById('settings-version');
            if (versionEl) versionEl.textContent = `v${version}`;

            const indexStatus = document.getElementById('settings-index-status');
            if (indexStatus) {
                const lastNotif = this.notifications[0];
                if (lastNotif) indexStatus.textContent = lastNotif.message;
            }
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    }

    closeSettings() {
        if (this.settingsMode) {
            CloseSettings();
            return;
        }
        this.settingsPanelEl.classList.add('hidden');
        this.searchInput.focus();
    }

    bindSettings() {
        const closeBtn = document.getElementById('settings-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.closeSettings());

        const cancelBtn = document.getElementById('settings-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', () => this.closeSettings());

        const saveBtn = document.getElementById('settings-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                const hotkey = document.getElementById('settings-hotkey-display')?.textContent || 'Alt+Space';
                const maxClipboard = parseInt(document.getElementById('settings-clipboard-size')?.value || '50', 10);
                try {
                    await SaveSettings(hotkey, maxClipboard);
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
        if (reindexBtn) {
            reindexBtn.addEventListener('click', async () => {
                await ReindexFiles();
                const statusEl = document.getElementById('settings-index-status');
                if (statusEl) statusEl.textContent = 'Reindexing…';
                this.showToast('Reindexing files', 'This may take a moment');
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

        const checkUpdatesBtn = document.getElementById('settings-check-updates');
        const updateStatus = document.getElementById('settings-update-status');
        if (checkUpdatesBtn) {
            checkUpdatesBtn.addEventListener('click', async () => {
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

        EventsOn('indexStatus', (status) => {
            const statusEl = document.getElementById('settings-index-status');
            if (statusEl && !this.settingsPanelEl.classList.contains('hidden')) {
                statusEl.textContent = status.message;
            }
        });
    }

    // --- Fallback Icons ---

    getFallbackIcon(category) {
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

    // --- Toast (left side of footer) ---

    showToast(message, detail = '') {
        const brand = document.getElementById('footer-brand');
        const toastEl = document.getElementById('footer-toast');

        brand.classList.add('hidden-by-toast');

        toastEl.textContent = message;
        toastEl.classList.add('visible');

        this.toastHovered = false;

        toastEl.onmouseenter = () => {
            this.toastHovered = true;
            clearTimeout(this.toastTimer);
        };

        toastEl.onmouseleave = () => {
            this.toastHovered = false;
            this.startToastDismiss(brand, toastEl);
        };

        clearTimeout(this.toastTimer);
        this.startToastDismiss(brand, toastEl);
    }

    startToastDismiss(brand, toastEl) {
        this.toastTimer = setTimeout(() => {
            if (this.toastHovered) return;
            toastEl.classList.remove('visible');
            brand.classList.remove('hidden-by-toast');
        }, 5000);
    }

    // --- Notification Indicator (bottom-right) ---

    listenIndexStatus() {
        EventsOn('indexStatus', (status) => {
            const stateIcons = {
                checking: '🔍',
                indexing: '📁',
                ready: '✓',
                idle: '—',
            };
            const icon = stateIcons[status.state] || '';
            this.setNotification(icon, status.message, status.state);
        });
    }

    setNotification(icon, message, state) {
        this.notifIcon.textContent = icon;
        this.notifText.textContent = message;

        this.notifications.unshift({
            icon,
            message,
            state,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        });

        if (this.notifications.length > 20) {
            this.notifications = this.notifications.slice(0, 20);
        }

        this.renderNotificationHistory();
    }

    bindNotificationUI() {
        this.notifIndicator.addEventListener('click', (e) => {
            e.stopPropagation();
            this.notifHistory.classList.toggle('hidden');
        });

        if (this.notifClear) {
            this.notifClear.addEventListener('click', () => {
                this.notifications = [];
                this.renderNotificationHistory();
            });
        }

        this.notifIndicator.addEventListener('mouseenter', () => {
            if (this.notifications.length > 0) {
                this.notifHistory.classList.remove('hidden');
            }
        });

        const footer = this.notifIndicator.closest('.footer');
        footer.addEventListener('mouseleave', () => {
            this.notifHistory.classList.add('hidden');
        });
    }

    renderNotificationHistory() {
        if (!this.notifHistoryList) return;

        if (this.notifications.length === 0) {
            this.notifHistoryList.innerHTML = '<div class="notif-history-empty">No notifications</div>';
            return;
        }

        this.notifHistoryList.innerHTML = this.notifications.map(n => `
            <div class="notif-history-item">
                <span class="notif-h-icon">${n.icon}</span>
                <div class="notif-h-text">
                    <div class="notif-h-msg">${this.escapeHtml(n.message)}</div>
                    <div class="notif-h-time">${n.time}</div>
                </div>
            </div>
        `).join('');
    }
}

document.addEventListener('DOMContentLoaded', () => new Blight());
