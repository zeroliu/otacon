// The app shell's sidebar collapse flag, persisted per device (app shell). The
// daemon owns plan state; the browser owns "did this person fold the sidebar
// away" — same split as the unread badges (seen.ts) and the renderer-reload
// guard (session-screen.tsx). Default is expanded (not collapsed): a first-time
// visitor gets the full session list, not a mystery handle. Pure read/write
// helpers tolerate an absent or throwing localStorage (Safari private mode) so a
// blocked store never crashes the shell — it just stops persisting the choice.

import { useState } from "react";

const KEY = "otacon-sidebar-collapsed";

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
