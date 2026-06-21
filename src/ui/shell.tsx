// The app shell (app shell): a persistent left sidebar — wordmark, settings gear,
// daemon link-state dot, a collapse toggle, and the live SessionList — wraps
// every route, with the routed screen rendered in the content track beside it.
// On desktop (≥960px) the sidebar is a fixed 240px column, collapsible with the
// choice persisted across reloads (sidebar-state); below 960px it's hidden and
// the session list is reached through a bottom-sheet overflow menu instead — a
// menu button in the review header on a plan, and a slim shell top-bar (wordmark
// + the same button) on the welcome / settings panes so the list is always one
// tap away on every route. The chrome is accent-NEUTRAL — `--hue` is never set
// here, so `--accent` resolves to the brand olive default; only an open review
// tints, via the page's own accent.
//
// The `[` / `]` session shortcuts mount here too: the shell is the one element
// present on every route, so the nav walks the active set from the welcome and
// settings panes, and there is exactly one mount (no competing copies). It reads
// useSessions() for the active id list and the link-state flag; that hook is now
// a context read off the single index stream the root provider owns (DECISIONS
// "Index stream is shared via a provider"), so the shell, the sidebar
// SessionList, and the mobile sheet's SessionList all share one EventSource.

import type { CSSProperties, ReactNode } from "react";
import { useSessions } from "./api";
import { LinkState } from "./chip";
import { linkClick, usePath } from "./router";
import { useSessionNav } from "./review/session-nav";
import { partitionByApproval } from "./session-filter";
import { SessionList } from "./session-list";
import { SessionMenuButton, SessionSheetProvider } from "./session-sheet";
import { useSidebarCollapsed } from "./sidebar-state";
import wordmarkUrl from "./otacon.svg";

/** The open review's id, or undefined off a `/s/:id` route (welcome / settings highlight nothing). */
function currentSessionId(path: string): string | undefined {
  return /^\/s\/([^/]+)$/.exec(path)?.[1];
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePath();
  const currentId = currentSessionId(path);
  const { sessions, connected } = useSessions();
  // `[` / `]` walk the active (non-over) set in activity order — the same set the
  // sidebar list and the mobile session sheet show — so the keyboard never stops
  // on a hidden over session. Mounted unconditionally here (stable hook order) so it's live on
  // every route, not just the review screen. partitionByApproval is the shared
  // split (session-filter), never reimplemented.
  const { active } = partitionByApproval(sessions);
  useSessionNav(active.map((s) => s.id), currentId ?? "");

  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  // A review screen (`/s/:id`) carries the "show sessions" button in its own
  // header, so the shell's mini top-bar is for the routes that have no header —
  // the welcome and settings panes — where it is the only <960px way to the list.
  const review = currentId !== undefined;

  return (
    <SessionSheetProvider currentId={currentId}>
    <div className={collapsed ? "app-shell collapsed" : "app-shell"}>
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
          <div className="app-sidebar-tools">
            <a
              className="settings-link"
              href="/settings"
              aria-label="settings"
              title="settings"
              onClick={linkClick("/settings")}
            >
              ⚙
            </a>
            <LinkState connected={connected} />
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
            at ≥960px and on review screens, whose own header carries the button):
            wordmark + the menu button, so the session list is reachable from the
            welcome and settings panes too, not just an open plan. */}
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
            <SessionMenuButton />
          </div>
        )}
        {children}
      </main>
    </div>
    </SessionSheetProvider>
  );
}
