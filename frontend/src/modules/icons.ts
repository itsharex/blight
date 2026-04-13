// Segoe Fluent Icons / Segoe MDL2 Assets glyph map — Windows only (PUA codepoints).
// On non-Windows these are invisible (.win-icon is display:none via CSS).
const CATEGORY_ICONS: Record<string, { glyph: string; color: string }> = {
    pinned: { glyph: '\uE718', color: 'rgba(92,154,255,0.75)' }, // Pin
    applications: { glyph: '\uE737', color: 'rgba(92,154,255,0.70)' }, // Apps
    recent: { glyph: '\uE81C', color: 'rgba(92,154,255,0.65)' }, // History
    suggested: { glyph: '\uE737', color: 'rgba(92,154,255,0.65)' }, // Apps
    folders: { glyph: '\uE8B7', color: 'rgba(255,190,60,0.80)' }, // OpenFolderHorizontal
    files: { glyph: '\uE8A5', color: 'rgba(255,255,255,0.55)' }, // Document
    web: { glyph: '\uE774', color: 'rgba(92,154,255,0.70)' }, // Globe2
    system: { glyph: '\uE770', color: 'rgba(255,255,255,0.50)' }, // System/PC
    calculator: { glyph: '\uE8EF', color: 'rgba(92,154,255,0.70)' }, // Calculator
    clipboard: { glyph: '\uE8C8', color: 'rgba(255,255,255,0.50)' }, // Copy/Clipboard
    aliases: { glyph: '\uE71B', color: 'rgba(92,154,255,0.70)' }, // Link
};

const DEFAULT_ICON = { glyph: '\uE8D5', color: 'rgba(255,255,255,0.35)' }; // BulletedList

// SVG fallbacks for non-Windows (macOS / Linux).
function getSvgFallback(category: string): string {
    const c = (category || '').toLowerCase();
    if (c === 'pinned' || c === 'applications' || c === 'recent' || c === 'suggested') {
        return `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="2" width="20" height="20" rx="5" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
            <rect x="5" y="5" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.2)"/>
            <rect x="13" y="5" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.15)"/>
            <rect x="5" y="13" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.15)"/>
            <rect x="13" y="13" width="6" height="6" rx="1.5" fill="rgba(255,255,255,0.1)"/>
        </svg>`;
    }
    if (c === 'folders') {
        return `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 7c0-1.1.9-2 2-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" fill="rgba(255,200,80,0.12)" stroke="rgba(255,200,80,0.35)" stroke-width="1.5"/>
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
    if (c === 'aliases') {
        return `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M13.5 6H5a2 2 0 00-2 2v8a2 2 0 002 2h13a2 2 0 002-2v-3" stroke="rgba(92,154,255,0.35)" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M17 3l4 4-4 4M21 7H13" stroke="rgba(92,154,255,0.5)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    }
    return `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="9" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
        <circle cx="12" cy="12" r="3" fill="rgba(255,255,255,0.15)"/>
    </svg>`;
}

// Returns the icon HTML for a result item fallback.
// On Windows: Segoe glyph (hidden on non-Windows via CSS).
// On non-Windows: SVG (hidden on Windows via CSS).
// Both are included; CSS at [data-os] controls which is visible.
export function getFallbackIcon(category: string): string {
    const { glyph, color } = CATEGORY_ICONS[(category || '').toLowerCase()] ?? DEFAULT_ICON;
    const winIcon = `<span class="win-icon" style="color:${color}" aria-hidden="true">${glyph}</span>`;
    const svgIcon = getSvgFallback(category);
    return winIcon + svgIcon;
}
