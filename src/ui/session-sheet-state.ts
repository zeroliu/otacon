// Open/close logic for the mobile session sheet (app shell), pulled out as pure
// functions so it unit-tests without a React render — the same split as
// compact.ts (nextCompact) and keyboard.ts (keyboardInset). The sheet is the
// <960px face of the session list: a header/mini-bar menu button opens it, a row
// tap or any route change closes it, and crossing up to the desktop breakpoint
// (where the sidebar IS the list) must never strand it open.

// The sidebar breakpoint (px): at and above this the persistent sidebar is the
// session list, so the sheet is never opened — below it, the sheet is the only
// face. Kept in lockstep with the CSS `min-width: 960px` shell media query and
// the menu button / mini-bar visibility rules (styles.css).
export const SIDEBAR_VIEWPORT = 960;

/** Whether the viewport is wide enough that the sidebar — not the sheet — is the list. */
export function isDesktopWidth(width: number): boolean {
  return width >= SIDEBAR_VIEWPORT;
}

/**
 * Whether an open session sheet should close, given the next render's facts.
 * Closes when the route changed under it (a row tap navigated, or back/forward
 * moved) so it never lingers over a screen it didn't open on, and when the
 * viewport crossed up to the desktop width (the sidebar took over the list, so a
 * stranded sheet would float with nothing to dismiss). A closed sheet stays
 * closed — this only ever decides whether to drop an open one.
 */
export function shouldCloseSheet(
  open: boolean,
  prevPath: string,
  nextPath: string,
  desktop: boolean,
): boolean {
  if (!open) return false;
  return desktop || prevPath !== nextPath;
}
