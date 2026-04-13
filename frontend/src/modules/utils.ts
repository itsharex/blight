export function escapeHtml(str: string): string {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function highlightMatch(text: string, query: string): string {
    if (!query) return escapeHtml(text);

    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();

    const idx = lowerText.indexOf(lowerQuery);
    if (idx !== -1) {
        return (
            escapeHtml(text.slice(0, idx)) +
            `<span class="match-chars">${escapeHtml(text.slice(idx, idx + lowerQuery.length))}</span>` +
            escapeHtml(text.slice(idx + lowerQuery.length))
        );
    }

    let result = '';
    let qi = 0;
    for (let i = 0; i < text.length; i++) {
        if (qi < lowerQuery.length && lowerText[i] === lowerQuery[qi]) {
            result += `<span class="match-char">${escapeHtml(text[i])}</span>`;
            qi++;
        } else {
            result += escapeHtml(text[i]);
        }
    }
    return result;
}

export function inputEl(id: string): HTMLInputElement | null {
    const el = document.getElementById(id);
    if (el instanceof HTMLInputElement) return el;
    // fluent-switch and fluent-text-field expose .checked / .value like native inputs
    if (el?.tagName.toLowerCase().startsWith('fluent-')) return el as unknown as HTMLInputElement;
    return null;
}

export function selectEl(id: string): HTMLSelectElement | null {
    const el = document.getElementById(id);
    if (el instanceof HTMLSelectElement) return el;
    // fluent-select exposes .value like a native select
    if (el?.tagName.toLowerCase().startsWith('fluent-')) return el as unknown as HTMLSelectElement;
    return null;
}
