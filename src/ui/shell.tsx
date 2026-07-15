// The app shell (app shell): a persistent left sidebar — wordmark, settings gear,
// a collapse toggle, and the live SessionList — wraps every route, with the routed
// screen rendered in the content track beside it. On desktop (≥960px) the sidebar
// is a left column the reader can drag-resize (the width persists across reloads,
// sidebar-state) and collapse (the choice persists too); below 960px it's hidden
// and the session list is reached either inline on the home route (welcome) or,
// from an open plan, through the bottom-sheet overflow menu the review header's ☰
// opens. The chrome is accent-NEUTRAL — `--hue` is never set here, so `--accent`
// resolves to the brand olive default; only an open review tints, via the page's
// own accent.
//
// The `[` / `]` session shortcuts mount here too: the shell is the one element
// present on every route, so the nav walks the active set from the welcome and
// settings panes, and there is exactly one mount (no competing copies). It reads
// useSessions() for the active id list; that hook is a context read off the single
// index stream the root provider owns (DECISIONS "Index stream is shared via a
// provider"), so the shell, the sidebar SessionList, and the mobile sheet's
// SessionList all share one EventSource.

import { useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useSessions } from "./api";
import { linkClick, usePath } from "./router";
import { useSessionNav } from "./review/session-nav";
import { partitionSessionKinds, partitionSessions } from "./session-filter";
import { SessionList } from "./session-list";
import { SessionSheetProvider } from "./session-sheet";
import {
  clampSidebarWidth,
  readSidebarWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebarCollapsed,
  writeSidebarWidth,
} from "./sidebar-state";
import wordmarkUrl from "./otacon.svg";

/** The open review's id, or undefined off a `/s/:id` route (welcome / settings highlight nothing). */
function currentSessionId(path: string): string | undefined {
  return /^\/s\/([^/]+)$/.exec(path)?.[1];
}

/** A keyboard step for the resize separator — arrow keys nudge the column 16px at a time. */
const RESIZE_STEP = 16;

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePath();
  const currentId = currentSessionId(path);
  const { sessions } = useSessions();
  // `[` / `]` walk the active (non-over) set in activity order — the same set the
  // sidebar list and the mobile session sheet show — so the keyboard never stops
  // on a hidden over session. Mounted unconditionally here (stable hook order) so it's live on
  // every route, not just the review screen. partitionSessions is the shared
  // split (session-filter), never reimplemented; only `active` matters here, and
  // its meaning (the non-terminal set) is unchanged by the three-way split.
  const { plans, reviews } = partitionSessionKinds(sessions);
  const { active } = partitionSessions(plans);
  const currentKind = sessions.find((session) => session.id === currentId)?.kind;
  const navigable = currentKind === "review" ? reviews : active;
  useSessionNav(navigable.map((session) => session.id), currentId ?? "");

  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  // The dragged column width (≥960px only), seeded once from localStorage so the
  // reader's chosen width is restored on reload. `resizing` only drives a cursor
  // + no-select wash while a drag is live.
  const [width, setWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);

  // Pointer drag on the separator: track the move on window (so the drag survives
  // the pointer leaving the thin handle), update the width live, and persist the
  // final width on release. The grid reads --sidebar-width, set inline below.
  const onResizeStart = (event: ReactPointerEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = width;
    let latest = startW;
    setResizing(true);
    const onMove = (move: PointerEvent): void => {
      latest = clampSidebarWidth(startW + (move.clientX - startX));
      setWidth(latest);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setResizing(false);
      writeSidebarWidth(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // pointercancel ends the same way: if the gesture is cancelled (OS gesture
    // takeover, capture loss) without a pointerup, tear down so a drag can't get
    // stuck (listeners leaked, the no-select wash / resize cursor frozen on).
    window.addEventListener("pointercancel", onUp);
  };

  // Keyboard resize for the separator (a11y): ←/→ nudge and persist immediately.
  const onResizeKey = (event: ReactKeyboardEvent): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = clampSidebarWidth(width + (event.key === "ArrowRight" ? RESIZE_STEP : -RESIZE_STEP));
    setWidth(next);
    writeSidebarWidth(next);
  };

  // A review screen (`/s/:id`) carries the "show sessions" button in its own
  // header, so the shell's mini top-bar (wordmark + settings) is for the routes
  // that have no header — the welcome and settings panes — giving them brand +
  // settings access below 960px, where the sidebar is hidden.
  const review = currentId !== undefined;

  let shellClass = "app-shell";
  if (collapsed) shellClass += " collapsed";
  if (resizing) shellClass += " resizing";

  return (
    <SessionSheetProvider currentId={currentId}>
    <div className={shellClass} style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
      <aside className="app-sidebar" aria-label="sessions">
        <div className="app-sidebar-head">
          {/* The wordmark doubles as the home link — back to the welcome pane. */}
          <a
            className="app-home"
            href="/"
            aria-label="otacon — home"
            title="otacon"
            onClick={linkClick("/")}
          >
            <span
              className="wordmark"
              aria-hidden="true"
              style={{ "--wordmark": `url(${wordmarkUrl})` } as CSSProperties}
            />
          </a>
          {/* Settings + the « collapse toggle ride the right of the logo row. */}
          <div className="app-sidebar-tools">
            <a
              className="settings-link"
              href="/knowledge"
              aria-label="knowledge"
              aria-current={path === "/knowledge" ? "page" : undefined}
              title="knowledge"
              onClick={linkClick("/knowledge")}
            >
              ▤
            </a>
            <a
              className="settings-link"
              href="/settings"
              aria-label="settings"
              aria-current={path === "/settings" ? "page" : undefined}
              title="settings"
              onClick={linkClick("/settings")}
            >
              ⚙
            </a>
            <button
              type="button"
              className="app-collapse"
              aria-label="collapse sidebar"
              title="collapse sidebar"
              onClick={toggleCollapsed}
            >
              «
            </button>
          </div>
        </div>
        <SessionList current={currentId} />
        {/* The drag-resize separator pinned on the sidebar's right edge (≥960px,
            expanded only — CSS). Inside the sidebar so it inherits its display
            gating; position:fixed escapes the column's overflow to span the edge. */}
        <div
          className="app-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="resize sidebar"
          aria-valuenow={width}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onKeyDown={onResizeKey}
        />
      </aside>
      <main className="app-content">
        {/* The expand handle: visible only when collapsed (CSS), ≥960px only —
            below that the sidebar is hidden and the session sheet is the face. */}
        {collapsed && (
          <button
            type="button"
            className="app-expand"
            aria-label="show sessions"
            title="show sessions"
            onClick={toggleCollapsed}
          >
            »
          </button>
        )}
        {/* The mobile mini top-bar (<960px, non-review routes only — CSS hides it
            at ≥960px and on review screens, whose own header carries the ☰): the
            wordmark home link + the settings gear, so brand and settings stay
            reachable on the welcome / settings panes where the sidebar is hidden. */}
        {!review && (
          <div className="app-topbar">
            <a
              className="app-topbar-home"
              href="/"
              aria-label="otacon — home"
              title="otacon"
              onClick={linkClick("/")}
            >
              <span
                className="wordmark"
                aria-hidden="true"
                style={{ "--wordmark": `url(${wordmarkUrl})` } as CSSProperties}
              />
            </a>
            <div className="app-topbar-tools">
              <a
                className="settings-link"
                href="/knowledge"
                aria-label="knowledge"
                aria-current={path === "/knowledge" ? "page" : undefined}
                title="knowledge"
                onClick={linkClick("/knowledge")}
              >
                ▤
              </a>
              <a
                className="settings-link"
                href="/settings"
                aria-label="settings"
                aria-current={path === "/settings" ? "page" : undefined}
                title="settings"
                onClick={linkClick("/settings")}
              >
                ⚙
              </a>
            </div>
          </div>
        )}
        {children}
      </main>
    </div>
    </SessionSheetProvider>
  );
}
