// The `/` content pane inside the app shell (app shell): the sidebar now carries
// the session list, so `/` is no longer an index — it's a welcome surface in the
// content track. Two faces, both centered in a neutral `.page` (no per-session
// accent — the chrome stays neutral; only an open review tints):
//   • zero sessions  → the empty-state copy lifted from the retired index screen,
//     including the offline hint when the daemon link is down;
//   • sessions exist  → a short "open a session" prompt. The copy is width-neutral:
//     ≥960px the live list is in the sidebar, but below 960px the sidebar is hidden
//     (the review switcher is the only face), so the wording points at no fixed spot.
// Reads useSessions() only for the connected flag + the count — it renders no
// list of its own. That hook is a context read off the single index stream the
// root provider owns, so the welcome pane adds no SSE connection of its own.

import { useSessions } from "./api";

export function Welcome() {
  const { sessions, connected } = useSessions();
  if (sessions.length === 0) return <EmptyPane connected={connected} />;
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
 * Sessions exist but none is open. The count is purely orienting copy; the live
 * list is the real index (the sidebar ≥960px, the review switcher below it), so
 * the prompt stays width-neutral rather than naming a spot the phone has hidden.
 */
function PickPane({ count }: { count: number }) {
  return (
    <div className="page">
      <main className="empty">
        <p className="empty-title">{count === 1 ? "1 session on the codec" : `${count} sessions on the codec`}</p>
        <p className="empty-body">
          Open a session to start its review — the plan, the threads, the interview, and
          Approve all live there.
        </p>
      </main>
    </div>
  );
}
