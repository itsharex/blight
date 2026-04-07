import {
    IsFirstRun, CompleteOnboarding, Search, Execute, HideWindow,
    GetContextActions, ExecuteContextAction, CheckForUpdates, InstallUpdate,
    GetIcon, GetConfig, SaveSettings, GetVersion, ReindexFiles, ClearIndex
} from '../wailsjs/go/main/App';
import { EventsOn } from '../wailsjs/runtime/runtime';

class Blight {
    constructor() {
        this.selectedIndex = 0;
        this.results = [];
        this.searchSeq = 0;
        this.debounceTimer = null;
        this.toastTimer = null;
        this.toastHovered = false;
        this.contextTarget = null;

        // Icon cache: path → base64 data URI (persists across re-renders)
        this.iconCache = new Map();

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
        if (!confirm(`Install update ${update.version}? The app will restart.`)) return;

        this.showToast('Downloading update…', 'Please wait');
        const res = await InstallUpdate();
        if (res === 'success') {
            this.showToast('Restarting…', 'Update applied successfully');
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
        this.searchInput.focus();
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

            if (!this.contextMenuEl.classList.contains('hidden')) {
                if (e.key === 'Escape') {
                    this.hideContextMenu();
                    e.preventDefault();
                }
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
                    this.executeSelected();
                    break;
                case 'Escape':
                    e.preventDefault();
                    if (this.searchInput.value) {
                        this.searchInput.value = '';
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

        // Click outside the window → hide
        // Guard against the blur that fires immediately after WindowShow (Alt+Space race).
        this.lastFocusAt = 0;
        window.addEventListener('focus', () => { this.lastFocusAt = Date.now(); });
        window.addEventListener('blur', () => {
            if (Date.now() - this.lastFocusAt < 600) return; // window just gained focus — ignore
            if (this.settingsPanelEl.classList.contains('hidden')) {
                HideWindow();
            }
        });

        // Listen for openSettings event from tray
        EventsOn('openSettings', () => this.openSettings());
    }

    onSearchInput() {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(async () => {
            const query = this.searchInput.value.trim();
            const seq = ++this.searchSeq;
            const results = await Search(query);
            if (seq !== this.searchSeq) return; // ignore stale responses
            this.results = results;
            this.selectedIndex = 0;
            this.renderResults();
        }, 120);
    }

    async loadDefaultResults() {
        const seq = ++this.searchSeq;
        const results = await Search('');
        if (seq !== this.searchSeq) return;
        this.results = results;
        this.selectedIndex = 0;
        this.renderResults();
    }

    moveSelection(delta) {
        if (this.results.length === 0) return;
        this.selectedIndex = (this.selectedIndex + delta + this.results.length) % this.results.length;
        this.renderResults();
        const selected = this.resultsContainer.querySelector('.result-item.selected');
        if (selected) selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
            return; // browser opens, no toast needed
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

    // --- Rendering ---

    renderResults() {
        if (this.results.length === 0) {
            this.resultsContainer.innerHTML = `
                <div class="no-results">
                    <div style="font-size: 24px; opacity: 0.3;">⌕</div>
                    <div>No results found</div>
                </div>
            `;
            return;
        }

        let html = '';
        let lastCategory = '';

        this.results.forEach((result, index) => {
            if (result.category !== lastCategory) {
                html += `<div class="result-category">${result.category}</div>`;
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

            html += `
                <div class="result-item ${selected}" data-index="${index}" data-id="${result.id}">
                    ${iconHtml}
                    <div class="result-text">
                        <div class="result-title">${result.title}</div>
                        <div class="result-subtitle">${result.subtitle}</div>
                    </div>
                    <div class="result-badge">${result.category}</div>
                </div>
            `;
        });

        this.resultsContainer.innerHTML = html;

        this.resultsContainer.querySelectorAll('.result-item').forEach(item => {
            item.addEventListener('click', () => {
                this.selectedIndex = parseInt(item.dataset.index);
                this.renderResults();
                this.executeSelected();
            });

            item.addEventListener('mouseenter', () => {
                this.selectedIndex = parseInt(item.dataset.index);
                this.renderResults();
            });

            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.selectedIndex = parseInt(item.dataset.index);
                this.renderResults();
                this.showContextMenu(e.clientX, e.clientY, item.dataset.id, item.querySelector('.result-title')?.textContent || '');
            });
        });

        // Async icon loading: only fetch icons not yet in cache
        this.results.forEach((result, index) => {
            if (!result.path || this.iconCache.has(result.path)) return;
            if (result.icon && result.icon.startsWith('data:')) return;
            GetIcon(result.path).then(icon => {
                if (!icon) return;
                this.iconCache.set(result.path, icon);
                // Update the placeholder if it's still rendered for this result index
                const el = this.resultsContainer.querySelector(`[data-icon-index="${index}"]`);
                if (el) el.outerHTML = `<div class="result-icon"><img src="${icon}" alt=""/></div>`;
            }).catch(() => {});
        });
    }

    // --- Context Menu ---

    async showContextMenu(x, y, resultId, resultTitle) {
        this.contextTarget = resultId;
        const actions = await GetContextActions(resultId);

        if (actions.length === 0) return;

        let html = '';
        if (resultTitle) {
            html += `<div class="context-menu-header">${resultTitle}</div>`;
        }
        actions.forEach(action => {
            html += `
                <button class="context-action" data-action="${action.id}">
                    <span class="context-action-icon">${action.icon}</span>
                    ${action.label}
                </button>
            `;
        });

        this.contextMenuEl.innerHTML = html;
        this.contextMenuEl.classList.remove('hidden');

        // Position with boundary clamping (measure after adding to DOM)
        this.contextMenuEl.style.left = '0px';
        this.contextMenuEl.style.top = '0px';
        const rect = this.contextMenuEl.getBoundingClientRect();
        const maxX = window.innerWidth - rect.width - 8;
        const maxY = window.innerHeight - rect.height - 8;
        this.contextMenuEl.style.left = `${Math.min(x, maxX)}px`;
        this.contextMenuEl.style.top = `${Math.min(y, maxY)}px`;

        this.contextMenuEl.querySelectorAll('.context-action').forEach(btn => {
            btn.addEventListener('click', async () => {
                const actionId = btn.dataset.action;
                const response = await ExecuteContextAction(this.contextTarget, actionId);
                this.hideContextMenu();
                this.handleContextResponse(actionId, response, resultTitle);
            });
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
    }

    // --- Settings Panel ---

    async openSettings() {
        this.settingsPanelEl.classList.remove('hidden');
        // Reset animation
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
                // Reflect current index state from last notification
                const lastNotif = this.notifications[0];
                if (lastNotif) indexStatus.textContent = lastNotif.message;
            }
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    }

    closeSettings() {
        this.settingsPanelEl.classList.add('hidden');
        this.searchInput.focus();
    }

    bindSettings() {
        const closeBtn = document.getElementById('settings-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.closeSettings());

        const saveBtn = document.getElementById('settings-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                const hotkey = document.getElementById('settings-hotkey-display')?.textContent || 'Alt+Space';
                const maxClipboard = parseInt(document.getElementById('settings-clipboard-size')?.value || '50', 10);
                try {
                    await SaveSettings(hotkey, maxClipboard);
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
        if (checkUpdatesBtn) {
            checkUpdatesBtn.addEventListener('click', async () => {
                checkUpdatesBtn.disabled = true;
                checkUpdatesBtn.textContent = 'Checking…';
                try {
                    const update = await CheckForUpdates();
                    if (update && update.available) {
                        this.showToast(`Update available: v${update.version}`, 'Click the update badge to install');
                        this.showUpdateUI(update);
                    } else if (update && update.error) {
                        this.showToast('Check failed', update.error);
                    } else {
                        this.showToast('Up to date', 'No updates available');
                    }
                } catch (e) {
                    this.showToast('Check failed', String(e));
                } finally {
                    checkUpdatesBtn.disabled = false;
                    checkUpdatesBtn.textContent = 'Check for Updates';
                }
            });
        }

        // Update index status in settings when events arrive
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
            return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="2" width="20" height="20" rx="5" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <rect x="5" y="5" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.2)"/>
                <rect x="13" y="5" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.15)"/>
                <rect x="5" y="13" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.15)"/>
                <rect x="13" y="13" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.1)"/>
            </svg>`;
        }
        if (c === 'files') {
            return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M6 2C4.9 2 4 2.9 4 4v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6z" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <path d="M14 2v6h6" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <line x1="8" y1="13" x2="16" y2="13" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <line x1="8" y1="16" x2="14" y2="16" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
            </svg>`;
        }
        if (c === 'web') {
            return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.15)" stroke-width="1" fill="rgba(255,255,255,0.05)"/>
                <path d="M12 3c0 0-3 3.5-3 9s3 9 3 9" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
                <path d="M12 3c0 0 3 3.5 3 9s-3 9-3 9" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
                <line x1="3" y1="12" x2="21" y2="12" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>
                <circle cx="17" cy="17" r="4" fill="#1e1e1e" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                <line x1="20" y1="20" x2="22" y2="22" stroke="rgba(255,255,255,0.2)" stroke-width="1.5" stroke-linecap="round"/>
            </svg>`;
        }
        if (c === 'system') {
            return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.2)" stroke-width="1"/>
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
            </svg>`;
        }
        return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
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
                    <div class="notif-h-msg">${n.message}</div>
                    <div class="notif-h-time">${n.time}</div>
                </div>
            </div>
        `).join('');
    }
}

document.addEventListener('DOMContentLoaded', () => new Blight());
