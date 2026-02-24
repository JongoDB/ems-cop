/**
 * DeviceIcons.ts — SVG device-type icons for Cytoscape network map nodes.
 *
 * Each icon is a 48x48 monochrome stroke-based SVG designed for dark
 * backgrounds (#0d1117). The optional `color` parameter controls stroke
 * colour and defaults to '#8899aa'.
 *
 * Usage:
 *   import { getDeviceSvgDataUri, DEVICE_TYPES } from './DeviceIcons';
 *   const uri = getDeviceSvgDataUri('server');          // default colour
 *   const uri2 = getDeviceSvgDataUri('router', '#ff0'); // custom colour
 */

const DEFAULT_COLOR = '#8899aa';

// ---------------------------------------------------------------------------
// Individual SVG builders (raw SVG markup, NOT encoded)
// ---------------------------------------------------------------------------

function svgWrap(color: string, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

const builders: Record<string, (c: string) => string> = {
  // Rack server: tall rectangle, 3 drive-bay lines, small LED circle
  server: (c) =>
    svgWrap(
      c,
      `<rect x="10" y="4" width="28" height="40" rx="2"/>` +
        `<line x1="15" y1="14" x2="33" y2="14"/>` +
        `<line x1="15" y1="24" x2="33" y2="24"/>` +
        `<line x1="15" y1="34" x2="33" y2="34"/>` +
        `<circle cx="32" cy="9" r="1.5"/>`
    ),

  // Router: box with 4 directional arrows (N/S/E/W)
  router: (c) =>
    svgWrap(
      c,
      `<rect x="14" y="14" width="20" height="20" rx="3"/>` +
        // North arrow
        `<line x1="24" y1="14" x2="24" y2="4"/><polyline points="20,8 24,4 28,8"/>` +
        // South arrow
        `<line x1="24" y1="34" x2="24" y2="44"/><polyline points="20,40 24,44 28,40"/>` +
        // West arrow
        `<line x1="14" y1="24" x2="4" y2="24"/><polyline points="8,20 4,24 8,28"/>` +
        // East arrow
        `<line x1="34" y1="24" x2="44" y2="24"/><polyline points="40,20 44,24 40,28"/>`
    ),

  // Firewall: brick wall with shield overlay
  firewall: (c) =>
    svgWrap(
      c,
      // Outer wall frame
      `<rect x="6" y="10" width="36" height="28" rx="1"/>` +
        // Row 1 bricks (offset)
        `<line x1="18" y1="10" x2="18" y2="18"/><line x1="30" y1="10" x2="30" y2="18"/>` +
        `<line x1="6" y1="18" x2="42" y2="18"/>` +
        // Row 2 bricks (offset from row 1)
        `<line x1="12" y1="18" x2="12" y2="26"/><line x1="24" y1="18" x2="24" y2="26"/><line x1="36" y1="18" x2="36" y2="26"/>` +
        `<line x1="6" y1="26" x2="42" y2="26"/>` +
        // Row 3
        `<line x1="18" y1="26" x2="18" y2="38"/><line x1="30" y1="26" x2="30" y2="38"/>` +
        // Shield overlay (center)
        `<path d="M24,16 L30,20 L30,28 C30,32 24,36 24,36 C24,36 18,32 18,28 L18,20 Z" stroke-width="1.5"/>`
    ),

  // Workstation: monitor on stand with keyboard line
  workstation: (c) =>
    svgWrap(
      c,
      // Monitor
      `<rect x="8" y="6" width="32" height="24" rx="2"/>` +
        // Screen inset
        `<rect x="12" y="10" width="24" height="16" rx="1"/>` +
        // Stand neck
        `<line x1="24" y1="30" x2="24" y2="36"/>` +
        // Stand base
        `<line x1="16" y1="36" x2="32" y2="36"/>` +
        // Keyboard
        `<rect x="12" y="40" width="24" height="4" rx="1"/>`
    ),

  // Network switch: wide rectangle with row of small port squares
  switch: (c) =>
    svgWrap(
      c,
      // Body
      `<rect x="4" y="16" width="40" height="16" rx="2"/>` +
        // Port squares (8 ports)
        `<rect x="7" y="20" width="3" height="3"/>` +
        `<rect x="12" y="20" width="3" height="3"/>` +
        `<rect x="17" y="20" width="3" height="3"/>` +
        `<rect x="22" y="20" width="3" height="3"/>` +
        `<rect x="27" y="20" width="3" height="3"/>` +
        `<rect x="32" y="20" width="3" height="3"/>` +
        `<rect x="37" y="20" width="3" height="3"/>` +
        // LEDs row
        `<circle cx="9" cy="27" r="1"/><circle cx="14" cy="27" r="1"/><circle cx="19" cy="27" r="1"/><circle cx="24" cy="27" r="1"/><circle cx="29" cy="27" r="1"/><circle cx="34" cy="27" r="1"/><circle cx="39" cy="27" r="1"/>`
    ),

  // Wireless AP: triangle base with curved radio wave arcs
  access_point: (c) =>
    svgWrap(
      c,
      // Base unit (trapezoid / triangle)
      `<polygon points="18,36 30,36 26,28 22,28"/>` +
        // Antenna mast
        `<line x1="24" y1="28" x2="24" y2="22"/>` +
        // Radio wave arcs (3 concentric)
        `<path d="M18,18 A8,8 0 0,1 30,18" fill="none"/>` +
        `<path d="M14,14 A14,14 0 0,1 34,14" fill="none"/>` +
        `<path d="M10,10 A20,20 0 0,1 38,10" fill="none"/>` +
        // Small base stand
        `<line x1="16" y1="40" x2="32" y2="40"/><line x1="24" y1="36" x2="24" y2="40"/>`
    ),

  // VPN gateway: padlock with tunnel/pipe through it
  vpn: (c) =>
    svgWrap(
      c,
      // Lock body
      `<rect x="14" y="22" width="20" height="16" rx="2"/>` +
        // Lock shackle
        `<path d="M18,22 L18,16 A6,6 0 0,1 30,16 L30,22" fill="none"/>` +
        // Keyhole
        `<circle cx="24" cy="29" r="2"/><line x1="24" y1="31" x2="24" y2="34"/>` +
        // Tunnel / pipe going through
        `<line x1="4" y1="30" x2="14" y2="30"/><line x1="34" y1="30" x2="44" y2="30"/>` +
        `<polyline points="7,27 4,30 7,33"/><polyline points="41,27 44,30 41,33"/>`
    ),

  // Printer: box with paper coming out, input tray
  printer: (c) =>
    svgWrap(
      c,
      // Body
      `<rect x="8" y="18" width="32" height="18" rx="2"/>` +
        // Paper output (top)
        `<path d="M14,18 L14,8 L34,8 L34,18" fill="none"/>` +
        // Printed paper curl
        `<path d="M14,8 Q14,4 18,4 L30,4 Q34,4 34,8" fill="none"/>` +
        // Output tray (bottom)
        `<path d="M10,36 L10,42 L38,42 L38,36" fill="none"/>` +
        // Control panel
        `<circle cx="32" cy="24" r="1.5"/><rect x="12" y="22" width="12" height="4" rx="1"/>`
    ),

  // IoT device: chip/microcontroller with pins on sides
  iot: (c) =>
    svgWrap(
      c,
      // Chip body
      `<rect x="14" y="14" width="20" height="20" rx="2"/>` +
        // Die marking
        `<circle cx="19" cy="19" r="1.5"/>` +
        // Left pins
        `<line x1="14" y1="19" x2="8" y2="19"/><line x1="14" y1="24" x2="8" y2="24"/><line x1="14" y1="29" x2="8" y2="29"/>` +
        // Right pins
        `<line x1="34" y1="19" x2="40" y2="19"/><line x1="34" y1="24" x2="40" y2="24"/><line x1="34" y1="29" x2="40" y2="29"/>` +
        // Top pins
        `<line x1="19" y1="14" x2="19" y2="8"/><line x1="24" y1="14" x2="24" y2="8"/><line x1="29" y1="14" x2="29" y2="8"/>` +
        // Bottom pins
        `<line x1="19" y1="34" x2="19" y2="40"/><line x1="24" y1="34" x2="24" y2="40"/><line x1="29" y1="34" x2="29" y2="40"/>`
    ),

  // Generic host: circle with small computer silhouette inside
  host: (c) =>
    svgWrap(
      c,
      `<circle cx="24" cy="24" r="18"/>` +
        // Tiny monitor
        `<rect x="17" y="16" width="14" height="10" rx="1"/>` +
        // Tiny stand
        `<line x1="24" y1="26" x2="24" y2="29"/>` +
        `<line x1="19" y1="29" x2="29" y2="29"/>` +
        // Tiny keyboard
        `<line x1="19" y1="32" x2="29" y2="32"/>`
    ),

  // Unknown: dashed circle with question mark
  unknown: (c) =>
    svgWrap(
      c,
      `<circle cx="24" cy="24" r="18" stroke-dasharray="4 3"/>` +
        `<text x="24" y="30" text-anchor="middle" font-size="20" font-family="monospace" fill="${c}" stroke="none">?</text>`
    ),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All recognised device type keys, suitable for dropdown menus. */
export const DEVICE_TYPES: string[] = [
  'server',
  'router',
  'firewall',
  'workstation',
  'switch',
  'access_point',
  'vpn',
  'printer',
  'iot',
  'host',
  'unknown',
];

/**
 * Returns a `data:image/svg+xml;utf8,...` URI for the given node type.
 * Falls back to the `unknown` icon for unrecognised types.
 */
export function getDeviceSvgDataUri(
  nodeType: string,
  color: string = DEFAULT_COLOR
): string {
  const key = nodeType.toLowerCase().trim();
  const build = builders[key] ?? builders['unknown'];
  const svg = build(color);
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
