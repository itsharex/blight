import {
    GetConfig,
    SaveSettings,
    GetVersion,
    GetStartupEnabled,
    GetDataDir,
    GetInstallDir,
    OpenFolder,
    OpenFolderPicker,
    ReindexFiles,
    ClearIndex,
    CancelIndex,
    CheckForUpdates,
    Uninstall,
    CloseSettings,
    ExportSettings,
    ImportSettings,
    GetAliases,
    SaveAlias,
    DeleteAlias,
} from '../../wailsjs/go/main/App';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { main, files } from '../../wailsjs/go/models';
import { escapeHtml, inputEl, selectEl } from './utils';
import { ToastType } from './toast';
import { showConfirmModal } from './modal';

export interface SettingsDeps {
    showToast: (msg: string, detail?: string, type?: ToastType) => void;
    applyRuntimeSettings: (cfg: main.BlightConfig) => void;
    onClose: () => void;
    settingsMode: boolean;
    getLastUpdateCheck: () => number;
    setLastUpdateCheck: (t: number) => void;
    onUpdateAvailable: (update: main.UpdateInfo) => void;
}

export class Settings {
    private panelEl: HTMLElement;
    private deps: SettingsDeps;
    private currentIndexDirs: string[] = [];
    private lastUpdateCheck = 0;

    constructor(panelEl: HTMLElement, deps: SettingsDeps) {
        this.panelEl = panelEl;
        this.deps = deps;
    }

    get isOpen(): boolean {
        return !this.panelEl.classList.contains('hidden');
    }

    async open(): Promise<void> {
        this.panelEl.classList.remove('hidden');
        this.panelEl.style.animation = 'none';
        void this.panelEl.offsetHeight; // force reflow
        this.panelEl.style.animation = '';

        this.activateTab('general');

        try {
            const [config, version, startupEnabled] = await Promise.all([
                GetConfig(),
                GetVersion(),
                GetStartupEnabled(),
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

            // Files tab
            const includeFolders = inputEl('settings-include-folders');
            if (includeFolders) includeFolders.checked = !config.disableFolderIndex;

            // Updates tab
            const versionEl = document.getElementById('settings-version');
            if (versionEl) versionEl.textContent = `v${version}`;

            // Misc tab
            GetDataDir()
                .then((d) => {
                    const el = document.getElementById('misc-data-dir');
                    if (el) el.textContent = d;
                })
                .catch(() => {});
            GetInstallDir()
                .then((d) => {
                    const el = document.getElementById('misc-install-dir');
                    if (el) el.textContent = d;
                })
                .catch(() => {});

            this.currentIndexDirs = config.indexDirs || [];
            this._renderIndexDirs();

            // Aliases tab
            this._loadAliasesTab();
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    }

    close(): void {
        if (this.deps.settingsMode) {
            CloseSettings();
            return;
        }
        this.panelEl.classList.add('hidden');
        this.deps.onClose();
    }

    activateTab(name: string): void {
        document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach((btn) => {
            const isActive = btn.dataset['tab'] === name;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', String(isActive));
        });
        document.querySelectorAll('.settings-tab').forEach((tab) => {
            tab.classList.toggle('hidden', tab.id !== `tab-${name}`);
        });
    }

    bind(): void {
        document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach((btn) => {
            btn.addEventListener('click', () => this.activateTab(btn.dataset['tab'] ?? ''));
        });
        this._bindTabKeyNav();
        this._bindAliasAdd();

        document.getElementById('settings-close')?.addEventListener('click', () => this.close());
        document.getElementById('settings-cancel')?.addEventListener('click', () => this.close());

        const saveBtn = document.getElementById('settings-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                const cfg = {
                    firstRun: false,
                    hotkey:
                        document.getElementById('settings-hotkey-display')?.textContent ||
                        'Alt+Space',
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
                    disableFolderIndex: !(inputEl('settings-include-folders')?.checked ?? true),
                    indexDirs: this.currentIndexDirs,
                };
                try {
                    const cfgObj = main.BlightConfig.createFrom(cfg);
                    await SaveSettings(cfgObj);
                    this.deps.applyRuntimeSettings(cfgObj);
                    if (this.deps.settingsMode) {
                        CloseSettings();
                        return;
                    }
                    this.deps.showToast('Settings saved', 'Changes applied', 'success');
                    this.close();
                } catch (e) {
                    this.deps.showToast('Save failed', String(e), 'error');
                }
            });
        }

        // Files / indexing
        document.getElementById('settings-reindex')?.addEventListener('click', async () => {
            await ReindexFiles();
            const statusEl = document.getElementById('settings-index-status');
            if (statusEl) statusEl.textContent = 'Reindexing…';
        });

        document
            .getElementById('settings-cancel-index')
            ?.addEventListener('click', () => CancelIndex());

        document.getElementById('settings-clear-index')?.addEventListener('click', async () => {
            await ClearIndex();
            const statusEl = document.getElementById('settings-index-status');
            if (statusEl) statusEl.textContent = 'Index cleared';
            this.deps.showToast('Index cleared', '');
        });

        document.getElementById('settings-add-dir')?.addEventListener('click', async () => {
            const dir = await OpenFolderPicker();
            if (dir) {
                this.currentIndexDirs = [...this.currentIndexDirs, dir];
                this._renderIndexDirs();
            }
        });

        EventsOn('indexStatus', (status: files.IndexStatus) => {
            const statusEl = document.getElementById('settings-index-status');
            if (statusEl) statusEl.textContent = status.message;
            const reindexBtn = document.getElementById(
                'settings-reindex'
            ) as HTMLButtonElement | null;
            const cancelBtn = document.getElementById('settings-cancel-index');
            const indexing = status.state === 'indexing';
            if (reindexBtn) reindexBtn.disabled = indexing;
            if (cancelBtn) cancelBtn.classList.toggle('hidden', !indexing);
        });

        // Updates tab
        const checkUpdatesBtn = document.getElementById(
            'settings-check-updates'
        ) as HTMLButtonElement | null;
        const updateStatus = document.getElementById('settings-update-status');
        if (checkUpdatesBtn) {
            checkUpdatesBtn.addEventListener('click', async () => {
                const cooldown = 10000;
                const elapsed = Date.now() - this.deps.getLastUpdateCheck();
                if (elapsed < cooldown) {
                    const remaining = Math.ceil((cooldown - elapsed) / 1000);
                    if (updateStatus) {
                        updateStatus.textContent = `Please wait ${remaining}s before checking again`;
                        updateStatus.className = 'settings-update-status error';
                    }
                    return;
                }
                this.deps.setLastUpdateCheck(Date.now());
                checkUpdatesBtn.disabled = true;
                checkUpdatesBtn.textContent = 'Checking…';
                if (updateStatus) {
                    updateStatus.textContent = '';
                    updateStatus.className = 'settings-update-status';
                }
                try {
                    const update = await CheckForUpdates();
                    if (update && update.available) {
                        if (updateStatus) {
                            updateStatus.textContent = `v${update.version} available — click badge in footer to install`;
                            updateStatus.className = 'settings-update-status success';
                        }
                        this.deps.onUpdateAvailable(update);
                    } else if (update && update.error) {
                        if (updateStatus) {
                            updateStatus.textContent = update.error;
                            updateStatus.className = 'settings-update-status error';
                        }
                    } else {
                        if (updateStatus) {
                            updateStatus.textContent = "You're on the latest version";
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

        // Misc tab
        document.getElementById('misc-open-data')?.addEventListener('click', async () => {
            const dir = await GetInstallDir();
            OpenFolder(dir);
        });
        document.getElementById('misc-open-install')?.addEventListener('click', async () => {
            const dir = await GetInstallDir();
            OpenFolder(dir);
        });
        document.getElementById('misc-uninstall')?.addEventListener('click', () => {
            showConfirmModal(
                'Uninstall blight?',
                'This will permanently remove blight from your system. Your config and data in .blight will not be deleted.',
                'Uninstall',
                true,
                async () => {
                    const res = await Uninstall();
                    if (res !== 'success') {
                        this.deps.showToast(
                            'Uninstall failed',
                            res
                                .replace('not-found:', 'Uninstaller not found: ')
                                .replace('error:', ''),
                            'error'
                        );
                    }
                }
            );
        });

        // Export / Import
        const exportBtn = document.getElementById('misc-export-settings');
        if (exportBtn) {
            exportBtn.addEventListener('click', async () => {
                try {
                    const json = await ExportSettings();
                    const blob = new Blob([json], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'blight-settings.json';
                    a.click();
                    URL.revokeObjectURL(url);
                    this.deps.showToast('Settings exported', 'blight-settings.json', 'success');
                } catch (e) {
                    this.deps.showToast('Export failed', String(e), 'error');
                }
            });
        }

        const importFileInput = document.getElementById(
            'misc-import-file'
        ) as HTMLInputElement | null;
        const importBtn = document.getElementById('misc-import-settings');
        if (importBtn && importFileInput) {
            importBtn.addEventListener('click', () => importFileInput.click());
            importFileInput.addEventListener('change', async () => {
                const file = importFileInput.files?.[0];
                if (!file) return;
                try {
                    const text = await file.text();
                    showConfirmModal(
                        'Import settings?',
                        'This will overwrite your current configuration. blight will reload the new settings immediately.',
                        'Import',
                        false,
                        async () => {
                            await ImportSettings(text);
                            this.deps.showToast(
                                'Settings imported',
                                'Reload blight to apply fully',
                                'success'
                            );
                        }
                    );
                } catch (e) {
                    this.deps.showToast('Import failed', String(e), 'error');
                }
                importFileInput.value = '';
            });
        }
    }

    updateIndexStatus(msg: string): void {
        const el = document.getElementById('settings-index-status');
        if (el) el.textContent = msg;
    }

    showUpdateInstallRow(version: string, onInstall: () => void): void {
        const row = document.getElementById('settings-update-install-row');
        const label = document.getElementById('settings-update-version-label');
        const installBtn = document.getElementById(
            'settings-install-update'
        ) as HTMLButtonElement | null;
        if (row) row.classList.remove('hidden');
        if (label) label.textContent = `v${version} available`;
        if (installBtn) installBtn.onclick = onInstall;
    }

    private _renderIndexDirs(): void {
        const container = document.getElementById('settings-index-dirs');
        if (!container) return;
        const dirs = this.currentIndexDirs;
        if (dirs.length === 0) {
            container.innerHTML =
                '<div style="font-size:11px;color:var(--text-tertiary)">No extra directories added</div>';
            return;
        }
        container.innerHTML = dirs
            .map(
                (d, i) => `
            <div class="settings-dir-item">
                <span class="settings-dir-path">${escapeHtml(d)}</span>
                <button class="settings-dir-remove" data-index="${i}">✕</button>
            </div>
        `
            )
            .join('');
        container.querySelectorAll<HTMLElement>('.settings-dir-remove').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset['index'] ?? '0', 10);
                this.currentIndexDirs = this.currentIndexDirs.filter((_, i) => i !== idx);
                this._renderIndexDirs();
            });
        });
    }

    private async _loadAliasesTab(): Promise<void> {
        try {
            const aliases = await GetAliases();
            this._renderAliases(aliases);
        } catch {
            /* non-critical */
        }
    }

    private _renderAliases(aliases: Record<string, string>): void {
        const list = document.getElementById('aliases-list');
        if (!list) return;
        const entries = Object.entries(aliases);
        if (entries.length === 0) {
            list.innerHTML =
                '<div style="font-size:11px;color:var(--text-tertiary);padding:8px 0">No aliases yet. Add one above.</div>';
            return;
        }
        list.innerHTML = entries
            .map(
                ([trigger, expansion]) => `
            <div class="alias-item">
                <span class="alias-trigger">${escapeHtml(trigger)}</span>
                <span class="alias-arrow">→</span>
                <span class="alias-expansion" title="${escapeHtml(expansion)}">${escapeHtml(expansion)}</span>
                <button class="alias-remove" data-trigger="${escapeHtml(trigger)}" title="Delete alias">✕</button>
            </div>
        `
            )
            .join('');
        list.querySelectorAll<HTMLElement>('.alias-remove').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const trigger = btn.dataset['trigger'] ?? '';
                await DeleteAlias(trigger);
                await this._loadAliasesTab();
                this.deps.showToast('Alias deleted', trigger, 'info');
            });
        });
    }

    private _bindAliasAdd(): void {
        const addBtn = document.getElementById('alias-add-btn');
        const triggerInput = document.getElementById(
            'alias-trigger-input'
        ) as HTMLInputElement | null;
        const expansionInput = document.getElementById(
            'alias-expansion-input'
        ) as HTMLInputElement | null;
        if (!addBtn || !triggerInput || !expansionInput) return;

        const doAdd = async () => {
            const trigger = triggerInput.value.trim();
            const expansion = expansionInput.value.trim();
            if (!trigger || !expansion) {
                this.deps.showToast('Both fields required', '', 'warning');
                return;
            }
            try {
                await SaveAlias(trigger, expansion);
                triggerInput.value = '';
                expansionInput.value = '';
                await this._loadAliasesTab();
                this.deps.showToast(`Alias "${trigger}" saved`, expansion, 'success');
            } catch (e) {
                this.deps.showToast('Save failed', String(e), 'error');
            }
        };

        addBtn.addEventListener('click', doAdd);
        expansionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doAdd();
        });
    }

    private _bindTabKeyNav(): void {
        const nav = document.querySelector<HTMLElement>('.settings-nav');
        if (!nav) return;
        nav.addEventListener('keydown', (e) => {
            const items = Array.from(nav.querySelectorAll<HTMLElement>('.settings-nav-item'));
            const current = items.findIndex((b) => b.classList.contains('active'));
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                items[(current + 1) % items.length]?.click();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                items[(current - 1 + items.length) % items.length]?.click();
            }
        });
        document.querySelectorAll<HTMLElement>('.settings-nav-item').forEach((btn) => {
            if (!btn.getAttribute('tabindex')) btn.setAttribute('tabindex', '0');
        });
    }
}
