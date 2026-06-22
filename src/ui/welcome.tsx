// The `/` content pane inside the app shell (app shell). Its face depends on width:
//   • ≥960px — the sidebar carries the live list, so `/` is a welcome surface:
//     zero sessions → the empty-state copy; sessions exist → a short "open a
//     session" prompt.
//   • <960px — the sidebar is hidden, so `/` IS the index again: it renders the
//     live SessionList (cards) inline, the way the home screen always did on a
//     phone, rather than a prompt pointing at a list the phone can't show.
// Neutral chrome (no per-session accent; only an open review tints). Reads
// useSessions() off the single shared index stream the root provider owns, so the
// welcome pane adds no SSE connection of its own.

import { useSessions } from "./api";
import { SessionList } from "./session-list";
import { useDesktopWidth } from "./viewport";

export function Welcome() {
  const { sessions, connected } = useSessions();
  const desktop = useDesktopWidth();
  if (sessions.length === 0) return <EmptyPane connected={connected} />;
  // Below the sidebar breakpoint the sidebar is hidden, so the home route is the
  // session index: render the cards inline. The same SessionList the sidebar and
  // the mobile sheet use — one list, rendered where the phone can reach it.
  if (!desktop) {
    return (
      <div className="page">
        <SessionList />
      </div>
    );
  }
  return <PickPane count={sessions.length} />;
}

/**
 * No sessions registered yet — the same copy the old index screen showed, so a
 * fresh install lands on a clear "run otacon start" prompt rather than a blank
 * track. The offline hint surfaces only when the daemon link is down.
 */
function EmptyPane({ connected }: { connected: boolean }) {
  return (
    <div className="page">
      <main className="empty">
        <p className="empty-title">no sessions on the codec</p>
        <p className="empty-body">
          From an agent session, run <code>otacon start --title &lt;feature&gt;</code> — its review
          card joins the session list the moment it registers.
        </p>
        {!connected && <p className="empty-offline">daemon unreachable — is otacond running?</p>}
      </main>
    </div>
  );
}

/**
 * Sessions exist but none is open, on a desktop where the sidebar already holds
 * the live list. The count is orienting copy; the sidebar is the real index, so
 * the prompt just points the reader at it.
 */
function PickPane({ count }: { count: number }) {
  return (
    <div className="page">
      <main className="empty">
        <p className="empty-title">{count === 1 ? "1 session on the codec" : `${count} sessions on the codec`}</p>
        <p className="empty-body">
          Open a session from the sidebar to start its review — the plan, the threads, the
          interview, and Approve all live there.
        </p>
      </main>
    </div>
  );
}
