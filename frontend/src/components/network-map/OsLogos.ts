/**
 * OsLogos.ts — Simplified OS logo SVGs for Cytoscape network map node badges.
 *
 * Each logo is a 24x24 fill-based (solid) SVG in a single colour (#8899aa),
 * designed to remain legible at 16x16 on dark backgrounds.
 *
 * Usage:
 *   import { detectOs, getOsLogoDataUri } from './OsLogos';
 *   const osKey = detectOs('Ubuntu 22.04');    // 'linux'
 *   const uri  = getOsLogoDataUri(osKey);      // data URI or null
 */

const LOGO_COLOR = '#8899aa';

// ---------------------------------------------------------------------------
// OS detection rules (order matters — first match wins)
// ---------------------------------------------------------------------------

interface OsRule {
  key: string;
  patterns: RegExp;
}

const OS_RULES: OsRule[] = [
  {
    key: 'linux',
    patterns:
      /linux|ubuntu|debian|centos|rhel|fedora|kali|arch|suse|alpine|mint/i,
  },
  {
    key: 'windows',
    patterns: /windows|win32|win64|win10|win11|microsoft/i,
  },
  {
    key: 'macos',
    patterns: /macos|darwin|mac\s?os|osx|apple/i,
  },
  {
    key: 'freebsd',
    patterns: /freebsd|openbsd|netbsd/i,
  },
  {
    key: 'cisco',
    patterns: /cisco|ios\s?xe|ios\s?xr|nxos|catalyst/i,
  },
  {
    key: 'android',
    patterns: /android/i,
  },
];

// ---------------------------------------------------------------------------
// SVG logo builders
// ---------------------------------------------------------------------------

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="${LOGO_COLOR}">${inner}</svg>`;
}

const logos: Record<string, string> = {
  // Linux — simplified Tux penguin outline
  linux: svgWrap(
    // Body
    `<path d="M12,2 C9,2 7,5 7,8 C7,10 7.5,11 6,13 C4.5,15 4,16 4,17.5 C4,19 5,20 7,20 L17,20 C19,20 20,19 20,17.5 C20,16 19.5,15 18,13 C16.5,11 17,10 17,8 C17,5 15,2 12,2Z"/>` +
      // Eyes
      `<circle cx="10" cy="8" r="1" fill="#0d1117"/><circle cx="14" cy="8" r="1" fill="#0d1117"/>` +
      // Beak
      `<path d="M11,10 L12,11.5 L13,10" fill="#0d1117" stroke="#0d1117" stroke-width="0.5"/>` +
      // Belly
      `<ellipse cx="12" cy="15" rx="3.5" ry="3" fill="#0d1117" opacity="0.3"/>`
  ),

  // Windows — 4-pane window grid with gap
  windows: svgWrap(
    `<rect x="2" y="2" width="9" height="9" rx="1"/>` +
      `<rect x="13" y="2" width="9" height="9" rx="1"/>` +
      `<rect x="2" y="13" width="9" height="9" rx="1"/>` +
      `<rect x="13" y="13" width="9" height="9" rx="1"/>`
  ),

  // macOS — apple silhouette
  macos: svgWrap(
    // Leaf
    `<path d="M13,2 C13,2 15,2 16,4 C14.5,4 13,3 13,2Z"/>` +
      // Apple body
      `<path d="M8,7 C5,7 3,10 3,14 C3,18 5.5,22 8,22 C9,22 10,21 12,21 C14,21 15,22 16,22 C18.5,22 21,18 21,14 C21,10 19,7 16,7 C14.5,7 13.5,8 12,8 C10.5,8 9.5,7 8,7Z"/>`
  ),

  // FreeBSD — simplified daemon/devil face
  freebsd: svgWrap(
    // Head circle
    `<circle cx="12" cy="13" r="9"/>` +
      // Horns
      `<path d="M6,6 L3,1 L7,5Z"/><path d="M18,6 L21,1 L17,5Z"/>` +
      // Eyes
      `<circle cx="9" cy="12" r="1.5" fill="#0d1117"/><circle cx="15" cy="12" r="1.5" fill="#0d1117"/>` +
      // Grin
      `<path d="M8,16 Q12,20 16,16" fill="none" stroke="#0d1117" stroke-width="1.5"/>`
  ),

  // Cisco — simplified bridge/network icon (two arcs bridged)
  cisco: svgWrap(
    // Bridge structure
    `<path d="M2,16 L2,10 Q12,2 22,10 L22,16" fill="none" stroke="${LOGO_COLOR}" stroke-width="2"/>` +
      // Vertical bars (stylised bridge piers)
      `<rect x="4" y="12" width="2" height="8" rx="0.5"/>` +
      `<rect x="9" y="8" width="2" height="12" rx="0.5"/>` +
      `<rect x="14" y="8" width="2" height="12" rx="0.5"/>` +
      `<rect x="19" y="12" width="2" height="8" rx="0.5"/>`
  ),

  // Android — robot head with antennae
  android: svgWrap(
    // Head
    `<rect x="4" y="8" width="16" height="12" rx="4"/>` +
      // Eyes
      `<circle cx="9" cy="14" r="1.5" fill="#0d1117"/><circle cx="15" cy="14" r="1.5" fill="#0d1117"/>` +
      // Left antenna
      `<line x1="8" y1="8" x2="6" y2="3" stroke="${LOGO_COLOR}" stroke-width="1.5" stroke-linecap="round"/>` +
      `<circle cx="6" cy="3" r="1"/>` +
      // Right antenna
      `<line x1="16" y1="8" x2="18" y2="3" stroke="${LOGO_COLOR}" stroke-width="1.5" stroke-linecap="round"/>` +
      `<circle cx="18" cy="3" r="1"/>`
  ),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect OS family from a free-form OS string. Returns a normalised key
 * ('linux' | 'windows' | 'macos' | 'freebsd' | 'cisco' | 'android' | 'unknown').
 */
export function detectOs(os: string, _osVersion?: string): string {
  if (!os) return 'unknown';
  for (const rule of OS_RULES) {
    if (rule.patterns.test(os)) return rule.key;
  }
  return 'unknown';
}

/**
 * Returns a `data:image/svg+xml;utf8,...` URI for the given OS key, or `null`
 * if the OS is unknown (no badge should be rendered).
 */
export function getOsLogoDataUri(os: string): string | null {
  const key = os.toLowerCase().trim();
  const svg = logos[key];
  if (!svg) return null;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
