import { CompleteOnboarding } from '../../wailsjs/go/main/App';

export class Splash {
    private splashEl: HTMLElement;
    private launcherEl: HTMLElement;
    private onComplete: () => void;
    private currentSlide = 0;

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

        document.getElementById('splash-next')?.addEventListener('click', () => {
            if (this.currentSlide < 3) this._goToSlide(this.currentSlide + 1);
        });

        document.getElementById('splash-skip')?.addEventListener('click', () => this._complete());
        document.getElementById('splash-go')?.addEventListener('click', () => this._complete());

        document.querySelectorAll<HTMLElement>('.splash-dot').forEach((dot) => {
            dot.addEventListener('click', () =>
                this._goToSlide(parseInt(dot.dataset['dot'] ?? '0', 10))
            );
        });
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

        const nextBtn = document.getElementById('splash-next');
        if (nextBtn) nextBtn.style.visibility = index >= 3 ? 'hidden' : 'visible';
        this.currentSlide = index;
    }

    private async _complete(): Promise<void> {
        await CompleteOnboarding('Alt+Space');
        this.splashEl.style.animation = 'splashOut 250ms ease forwards';
        setTimeout(() => this.onComplete(), 250);
    }
}
