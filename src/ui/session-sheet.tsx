// The mobile session sheet (app shell): below 960px the persistent sidebar is
// hidden, so the session list is reached through a bottom-docked sheet a header
// (or the mini top-bar) menu button opens. A scrim backs it; a row tap, the Esc
// key, a scrim tap, or any route change closes it; crossing up to the desktop
// width (where the sidebar IS the list) drops it so it can never strand open.
// The opener is published through a context so the review header — which the
// shell wraps as `children` — can trigger the one sheet the shell hosts, rather
// than threading a prop through every screen.
//
// The pure open/close decisions live in session-sheet-state.ts (shouldCloseSheet
// / isDesktopWidth), unit-tested without a render; this module is the React skin:
// the provider state, the breakpoint subscription, and the sheet markup (which
// reuses useScrollLock + the --kb-inset var like the review sheets).

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePath } from "./router";
import { useScrollLock } from "./review/keyboard";
import { SessionList } from "./session-list";
import { isDesktopWidth, shouldCloseSheet, SIDEBAR_VIEWPORT } from "./session-sheet-state";

/** The opener handed to any header/bar that wants to surface the session list (<960px). */
interface SessionSheetApi {
  open: () => void;
}

const SessionSheetContext = createContext<SessionSheetApi>({ open: () => undefined });

/** The shell-mounted opener — `open()` surfaces the mobile session sheet. */
export function useSessionSheet(): SessionSheetApi {
  return useContext(SessionSheetContext);
}

/**
 * Tracks whether the viewport is at/above the sidebar breakpoint, off the same
 * `min-width: 960px` media query the CSS shell uses, so the sheet logic and the
 * chrome flip together. Seeded from the live width so the first render is right.
 */
function useDesktopWidth(): boolean {
  const [desktop, setDesktop] = useState(() => isDesktopWidth(window.innerWidth));
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${SIDEBAR_VIEWPORT}px)`);
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return desktop;
}

/**
 * Hosts the single mobile session sheet for the whole tree and publishes its
 * opener through context. `currentId` highlights the open review's row in the
 * list; it's undefined off a `/s/:id` route. Mounted once in the shell, so the
 * review header, the mini top-bar, and any future bar all drive the same sheet.
 */
export function SessionSheetProvider({
  currentId,
  children,
}: {
  currentId?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const path = usePath();
  const desktop = useDesktopWidth();
  // Auto-close on any route change (a row tap navigates, back/forward moves) and
  // on crossing up to the desktop width (the sidebar took over the list). The
  // pure decision lives in shouldCloseSheet; the previous path is held in a ref
  // so a re-render that didn't change the route doesn't read as a change.
  const prevPath = useRef(path);
  useEffect(() => {
    if (shouldCloseSheet(open, prevPath.current, path, desktop)) setOpen(false);
    prevPath.current = path;
  }, [open, path, desktop]);

  return (
    <SessionSheetContext.Provider value={{ open: () => setOpen(true) }}>
      {children}
      {/* Never mounted on desktop: the sidebar is the list there. The guard above
          also closes a sheet left open while crossing the breakpoint. */}
      {open && !desktop && (
        <SessionSheet currentId={currentId} onClose={() => setOpen(false)} />
      )}
    </SessionSheetContext.Provider>
  );
}

/**
 * The bottom-docked sheet itself: a scrim (dismiss on tap) over a panel that
 * renders the live SessionList. Esc closes it; a row tap closes it via
 * `onNavigate` (and the route-change guard backs that up). Locks the page behind
 * it and rides --kb-inset like the review sheets, so it sits consistently even
 * if the keyboard ever rises behind it.
 */
function SessionSheet({ currentId, onClose }: { currentId?: string; onClose: () => void }) {
  useScrollLock(true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="ss-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ss-sheet" role="dialog" aria-modal="true" aria-label="sessions">
        <div className="ss-head">
          <span className="ss-title">sessions</span>
          <button type="button" className="composer-close" onClick={onClose}>
            esc
          </button>
        </div>
        <SessionList current={currentId} onNavigate={onClose} />
      </div>
    </div>
  );
}

/**
 * The "show sessions" menu glyph (<960px): a lozenge button any header or bar
 * drops to open the sheet. The glyph (☰) and label match the desktop collapsed
 * sidebar's » expand handle's intent — both are the "session list" control — so
 * the mobile and desktop affordances read as the same thing. Hidden at ≥960px by
 * CSS (the sidebar is the list); the caller decides where it sits.
 */
export function SessionMenuButton({ className }: { className?: string }) {
  const { open } = useSessionSheet();
  return (
    <button
      type="button"
      className={className ? `ss-menu ${className}` : "ss-menu"}
      aria-label="show sessions"
      title="show sessions"
      onClick={open}
    >
      <span aria-hidden="true">☰</span>
    </button>
  );
}
