// Scroll→compact threshold math for the sticky session header (review UI).
// Pure and DOM-free so it unit-tests in isolation; the rAF-throttled
// `useCompactOnScroll` hook in header.tsx wraps it around `window.scrollY`.

// Scroll offsets (px). A small hysteresis band keeps the header from
// flickering when a scroll settles on the boundary; at the very top it always
// re-expands, so the masthead is whole when you arrive at a plan.
export const COMPACT_ENTER = 48;
export const COMPACT_EXIT = 12;

/** Next compact state for a scroll offset, holding within the hysteresis band. */
export function nextCompact(scrollY: number, compact: boolean): boolean {
  if (scrollY >= COMPACT_ENTER) return true;
  if (scrollY <= COMPACT_EXIT) return false;
  return compact;
}
