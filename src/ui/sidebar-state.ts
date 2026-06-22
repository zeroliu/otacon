// The app shell's sidebar state, persisted per device (app shell): the collapse
// flag and the dragged column width. The daemon owns plan state; the browser owns
// "did this person fold the sidebar away, and how wide do they like it" — same
// split as the unread badges (seen.ts) and the renderer-reload guard
// (session-screen.tsx). Defaults are expanded + 240px: a first-time visitor gets
// the full session list at the design width, not a mystery handle. Pure
// read/write helpers tolerate an absent or throwing localStorage (Safari private
// mode) so a blocked store never crashes the shell — it just stops persisting.

import { useState } from "react";

const KEY = "otacon-sidebar-collapsed";
const WIDTH_KEY = "otacon-sidebar-width";

// The drag bounds: wide enough that a title row stays legible, narrow enough that
// the reading column + threads rail still fit beside it on a laptop. 240 is the
// design default the fixed column shipped at.
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 240;

/**
 * Whether the desktop sidebar is collapsed. Defaults to false (expanded) when no
 * choice is stored, the value isn't the literal "1", or localStorage is absent /
 * throwing — so a missing or hostile store reads as the safe expanded default.
 */
export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the collapse flag; a throwing/absent store is swallowed (no persist). */
export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // storage unavailable (private mode): the choice just doesn't persist
  }
}

/**
 * The collapse flag plus a toggle that writes through to localStorage, so the
 * choice survives a reload. Seeded once from the store (lazy initializer) so the
 * read runs at mount, not on every render. Returns a stable readonly tuple, like
 * a useState pair.
 */
export function useSidebarCollapsed(): readonly [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const toggle = (): void =>
    setCollapsed((prev) => {
      const next = !prev;
      writeSidebarCollapsed(next);
      return next;
    });
  return [collapsed, toggle];
}

/** Clamp a candidate width into the drag bounds; a non-finite value falls back to the default. */
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(px)));
}

/**
 * The persisted sidebar width in px. Defaults to 240 when nothing is stored, the
 * stored value isn't a finite number, or localStorage is absent / throwing — and
 * a stored value is re-clamped on read so a stale out-of-bounds entry (e.g. from
 * a wider monitor) can never widen the column past the current max.
 */
export function readSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (raw === null) return SIDEBAR_DEFAULT_WIDTH;
    const n = Number(raw);
    return Number.isFinite(n) ? clampSidebarWidth(n) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

/** Persist the sidebar width (clamped); a throwing/absent store is swallowed (no persist). */
export function writeSidebarWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(clampSidebarWidth(px)));
  } catch {
    // storage unavailable (private mode): the width just doesn't persist
  }
}
