export function showConfirmModal(
    title: string,
    body: string,
    okLabel: string,
    danger: boolean,
    onOk: () => void
): void {
    const modal = document.getElementById('confirm-modal')!;
    document.getElementById('confirm-modal-title')!.textContent = title;
    document.getElementById('confirm-modal-body')!.textContent = body;
    const okBtn = document.getElementById('confirm-modal-ok') as HTMLButtonElement;
    okBtn.textContent = okLabel;
    okBtn.className = danger
        ? 'settings-btn settings-btn-danger'
        : 'settings-btn settings-btn-primary';
    const cancelBtn = document.getElementById('confirm-modal-cancel')!;
    const cleanup = () => {
        modal.classList.add('hidden');
        okBtn.onclick = null;
        cancelBtn.onclick = null;
    };
    okBtn.onclick = () => {
        cleanup();
        onOk();
    };
    cancelBtn.onclick = () => cleanup();
    modal.classList.remove('hidden');
}
