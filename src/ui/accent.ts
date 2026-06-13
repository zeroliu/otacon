// Stable per-session accent color (DESIGN.md §7): FNV-1a over the session id
// picks a hue; saturation/lightness are fixed per color scheme in styles.css
// (DECISIONS.md "Session accent color: FNV-1a of the id picks a hue").

import type { CSSProperties } from "react";

/** 32-bit FNV-1a → 0..359. Deterministic on every device, no stored state. */
export function accentHue(sessionId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    hash ^= sessionId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/** Inline style carrying the session's accent hue custom property. */
export function accentStyle(sessionId: string): CSSProperties {
  return { "--hue": String(accentHue(sessionId)) } as CSSProperties;
}
