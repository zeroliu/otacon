// Session navigation shortcuts (review UI): `[` and `]` step to the previous /
// next session so a reviewer can sweep a queue without reaching for the mouse.
// The global keydown listener must never hijack typing — every text-entry target
// is filtered through `isTypingTarget`, and modified chords (esp. Cmd+[ /Cmd+]
// for browser back/forward) are left untouched. The wrap-around neighbor pick is
// split out as a pure function so it unit-tests without a DOM or a live router.

import { useEffect } from "react";
import { navigate } from "../router";

/**
 * True when `target` is a text-entry element a shortcut must not steal keys from
 * — an `<input>`/`<textarea>`/`<select>`, or anything contentEditable. This is
 * the single source of truth for the "don't interfere with typing" rule (it
 * mirrors the inline guard in ../session-screen.tsx). Guards against non-Element
 * targets (`window`/`document`) by duck-typing on `tagName` rather than an
 * `instanceof HTMLElement` check, which is brittle across realms / test DOMs.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as Partial<HTMLElement> & { getAttribute?(name: string): string | null };
  if (typeof el.tagName !== "string") return false;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.isContentEditable) return true;
  // Fallback for DOMs that don't compute `isContentEditable`: a present
  // `contenteditable` attribute (anything but "false") means editable.
  const attr = el.getAttribute?.("contenteditable");
  return attr != null && attr !== "false";
}

/**
 * The id `delta` (+1 next, -1 previous) steps from `current` in `orderedIds`,
 * wrapping around both ends. Returns null — caller should not navigate — when
 * the list has fewer than two entries or `current` isn't in it.
 */
export function adjacentSession(
  orderedIds: string[],
  current: string,
  delta: 1 | -1,
): string | null {
  const n = orderedIds.length;
  if (n < 2) return null;
  const idx = orderedIds.indexOf(current);
  if (idx === -1) return null;
  return orderedIds[(idx + delta + n) % n] ?? null;
}

/**
 * Wire `[` / `]` to navigate to the previous / next session in `orderedIds`.
 * Skips modified chords (so Cmd+[ stays browser-back) and any keypress while a
 * text field is focused. Rebinds when the list or current session changes.
 */
export function useSessionNav(orderedIds: string[], current: string): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const delta = event.key === "[" ? -1 : event.key === "]" ? 1 : null;
      if (delta === null) return;
      const id = adjacentSession(orderedIds, current, delta);
      if (id === null) return;
      event.preventDefault();
      navigate(`/s/${id}`);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [orderedIds, current]);
}
