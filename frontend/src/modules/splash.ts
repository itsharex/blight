import { CompleteOnboarding } from '../../wailsjs/go/main/App';

export class Splash {
    private splashEl: HTMLElement;
    private launcherEl: HTMLElement;
    private onComplete: () => void;
    private currentSlide = 0;
    private readonly TOTAL_SLIDES = 5;

    // User preferences tracked during onboarding
    private _hotkey = 'Alt+Space';
    private _theme = 'dark';
    private _useAnimation = true;

    // Hotkey recorder state
    private _hkPending = 'Alt+Space';
    private _hkKeydownFn: ((e: KeyboardEvent) => void) | null = null;
    private _hkKeyupFn: ((e: KeyboardEvent) => void) | null = null;

    constructor(splashEl: HTMLElement, launcherEl: HTMLElement, onComplete: () => void) {
        this.splashEl = splashEl;
        this.launcherEl = launcherEl;
        this.onComplete = onComplete;
    }

    show(): void {
        this.splashEl.classList.remove('hidden');
        this.launcherEl.classList.add('hidden');
        this._init();
    }

    private _init(): void {
        this.currentSlide = 0;
        this._goToSlide(0);

        // Navigation buttons
        document.getElementById('splash-next')?.addEventListener('click', () => {
            if (this.currentSlide < this.TOTAL_SLIDES - 1) {
                this._goToSlide(this.currentSlide + 1);
            }
        });

        document.getElementById('splash-back')?.addEventListener('click', () => {
            if (this.currentSlide > 0) this._goToSlide(this.currentSlide - 1);
        });

        document.getElementById('splash-skip')?.addEventListener('click', () => this._complete());
        document.getElementById('splash-go')?.addEventListener('click', () => this._complete());

        document.querySelectorAll<HTMLElement>('.splash-dot').forEach((dot) => {
            dot.addEventListener('click', () =>
                this._goToSlide(parseInt(dot.dataset['dot'] ?? '0', 10))
            );
        });

        // Theme card selection
        document.querySelectorAll<HTMLElement>('[data-theme-card]').forEach((card) => {
            card.addEventListener('click', () => {
                this._selectTheme(card.dataset['themeCard'] ?? 'dark');
            });
        });

        // Animation toggle
        const animSwitch = document.getElementById('splash-anim-switch') as HTMLInputElement & {
            checked: boolean;
        };
        if (animSwitch) {
            animSwitch.addEventListener('change', () => {
                this._useAnimation = animSwitch.checked !== false;
                document.documentElement.classList.toggle('no-animations', !this._useAnimation);
            });
        }

        // Hotkey reset
        document.getElementById('splash-hk-reset')?.addEventListener('click', () => {
            this._hkPending = 'Alt+Space';
            this._hotkey = 'Alt+Space';
            this._renderHkCanvas(['Alt', 'Space'], true);
        });

        // Bind global hotkey recorder (only active on hotkey slide)
        this._bindHotkeyRecorder();
    }

    private _selectTheme(theme: string): void {
        this._theme = theme;
        document.documentElement.dataset['theme'] = theme;

        document.querySelectorAll<HTMLElement>('[data-theme-card]').forEach((card) => {
            card.classList.toggle('selected', card.dataset['themeCard'] === theme);
        });
    }

    private _bindHotkeyRecorder(): void {
        // Show the default hotkey as chips immediately
        this._renderHkCanvas(['Alt', 'Space'], true);

        this._hkKeydownFn = (e: KeyboardEvent) => {
            if (this.currentSlide !== 2) return;

            e.preventDefault();
            e.stopImmediatePropagation();

            const mods: string[] = [];
            if (e.ctrlKey) mods.push('Ctrl');
            if (e.altKey) mods.push('Alt');
            if (e.shiftKey) mods.push('Shift');
            if (e.metaKey) mods.push('Win');

            const isModKey = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS'].includes(e.key);

            if (e.key === 'Escape' && mods.length === 0) return;

            if (isModKey) {
                this._renderHkCanvas(mods, false);
            } else {
                const mainKey = this._mapHkKey(e.key);
                if (mainKey && mods.length > 0) {
                    const combo = [...mods, mainKey].join('+');
                    this._hkPending = combo;
                    this._hotkey = combo;
                    this._renderHkCanvas([...mods, mainKey], true);
                } else if (mainKey) {
                    // main key without modifier — show but dimmed (invalid)
                    this._renderHkCanvas([mainKey], false);
                }
            }
        };

        this._hkKeyupFn = (e: KeyboardEvent) => {
            if (this.currentSlide !== 2) return;
            e.preventDefault();

            if (this._hkPending) {
                this._renderHkCanvas(this._hkPending.split('+'), true);
            } else {
                const mods: string[] = [];
                if (e.ctrlKey) mods.push('Ctrl');
                if (e.altKey) mods.push('Alt');
                if (e.shiftKey) mods.push('Shift');
                if (e.metaKey) mods.push('Win');
                this._renderHkCanvas(mods.length > 0 ? mods : null, false);
            }
        };

        document.addEventListener('keydown', this._hkKeydownFn, true);
        document.addEventListener('keyup', this._hkKeyupFn, true);
    }

    private _renderHkCanvas(parts: string[] | null, hasMain: boolean): void {
        const placeholder = document.getElementById('splash-hk-placeholder');
        const chipsRow = document.getElementById('splash-hk-chips-row');
        if (!placeholder || !chipsRow) return;

        if (!parts || parts.length === 0) {
            placeholder.style.display = '';
            chipsRow.style.display = 'none';
            chipsRow.innerHTML = '';
            return;
        }

        placeholder.style.display = 'none';
        chipsRow.style.display = 'flex';
        chipsRow.style.opacity = hasMain ? '1' : '0.45';

        chipsRow.innerHTML = parts
            .map((key, i) => {
                const isMain = hasMain && i === parts.length - 1;
                const cls = isMain ? 'hotkey-chip hotkey-chip-main' : 'hotkey-chip';
                const sep = i < parts.length - 1 ? '<div class="hotkey-plus">+</div>' : '';
                return `<div class="${cls}">${key}</div>${sep}`;
            })
            .join('');
    }

    private _mapHkKey(key: string): string {
        if (key === ' ') return 'Space';
        if (key === 'Tab') return 'Tab';
        if (key === 'Enter') return 'Enter';
        if (key === 'Backspace') return 'Backspace';
        if (key === 'Delete') return 'Delete';
        if (key === 'Escape') return 'Escape';
        if (/^F([1-9]|1[0-2])$/.test(key)) return key;
        if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase();
        if (/^[0-9]$/.test(key)) return key;
        return '';
    }

    private _goToSlide(index: number): void {
        document.querySelectorAll('.splash-slide').forEach((slide, i) => {
            slide.classList.remove('active', 'exit-left');
            if (i < index) slide.classList.add('exit-left');
            if (i === index) slide.classList.add('active');
        });

        document.querySelectorAll('.splash-dot').forEach((dot, i) => {
            dot.classList.toggle('active', i === index);
        });

        // Back button — hidden on first slide
        const backBtn = document.getElementById('splash-back') as HTMLElement | null;
        if (backBtn) backBtn.style.visibility = index === 0 ? 'hidden' : 'visible';

        // Next button — hidden on last slide (replaced by in-slide "Launch" button)
        const nextBtn = document.getElementById('splash-next') as HTMLElement | null;
        if (nextBtn) {
            if (index >= this.TOTAL_SLIDES - 1) {
                nextBtn.style.visibility = 'hidden';
            } else {
                nextBtn.style.visibility = 'visible';
            }
        }

        // Focus the hotkey canvas when entering the hotkey slide
        if (index === 2) {
            setTimeout(() => document.getElementById('splash-hk-canvas')?.focus(), 80);
        }

        // Build summary when entering the ready slide
        if (index === this.TOTAL_SLIDES - 1) {
            this._buildSummary();
        }

        this.currentSlide = index;
    }

    private _buildSummary(): void {
        const el = document.getElementById('splash-summary');
        if (!el) return;

        const themeLabels: Record<string, string> = {
            dark: 'Dark',
            light: 'Light',
            system: 'Follow System',
        };

        el.innerHTML = `
            <div class="splash-summary-row">
                <span class="win-icon splash-summary-icon">&#xE771;</span>
                <svg class="splash-summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="5"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
                </svg>
                <span>Theme: <strong>${themeLabels[this._theme] ?? 'Dark'}</strong></span>
            </div>
            <div class="splash-summary-row">
                <span class="win-icon splash-summary-icon">&#xE92E;</span>
                <svg class="splash-summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2" y="6" width="20" height="13" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>
                </svg>
                <span>Hotkey: <strong>${this._hotkey}</strong></span>
            </div>
            <div class="splash-summary-row">
                <span class="win-icon splash-summary-icon">&#xEB3B;</span>
                <svg class="splash-summary-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
                <span>Animations: <strong>${this._useAnimation ? 'Enabled' : 'Disabled'}</strong></span>
            </div>
        `;
    }

    private async _complete(): Promise<void> {
        // Clean up global key listeners
        if (this._hkKeydownFn) document.removeEventListener('keydown', this._hkKeydownFn, true);
        if (this._hkKeyupFn) document.removeEventListener('keyup', this._hkKeyupFn, true);

        await CompleteOnboarding(this._hotkey, this._theme, this._useAnimation);
        this.splashEl.style.animation = 'splashOut 250ms ease forwards';
        setTimeout(() => this.onComplete(), 250);
    }
}
