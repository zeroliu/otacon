// The Index — the phone bookmark (DESIGN.md §10): one card per session,
// status chip, unread badge, last activity, session accent. Live over SSE.

import type { CSSProperties, MouseEvent } from "react";
import { useState } from "react";
import { accentStyle } from "./accent";
import type { LiveSession } from "./api";
import { useSessions } from "./api";
import { AgentDot, LinkState, StatusChip } from "./chip";
import { relativeTime, repoName } from "./format";
import { navigate } from "./router";
import { unreadCount } from "./seen";
import { partitionByApproval } from "./session-filter";
import { useNow } from "./tick";

export function IndexScreen() {
  const { sessions, connected } = useSessions();
  // One ticking clock for the whole list: keeps "3m ago" and every card's
  // agent-presence dot honest while the page idles between SSE frames.
  const now = useNow(30_000);
  // Approved sessions leave the main list for a collapsed section below
  // (DESIGN.md §10) so finished plans stop crowding what still needs you; the
  // switcher hides them outright (§7). One shared split keeps the two surfaces
  // in agreement.
  const { active, approved } = partitionByApproval(sessions);
  return (
    <div className="page">
      <header className="masthead">
        <div>
          <h1 className="wordmark">otacon</h1>
          <p className="tagline">mission support · plan review</p>
        </div>
        <LinkState connected={connected} />
      </header>
      <div className="list-head" aria-hidden="true">
        <span>
          {/* The count tracks what still needs you — the active list — not the
              registry total; the approved section carries its own count (D5). */}
          sessions <span className="list-count">{active.length}</span>
        </span>
        <span className="freq">140.85</span>
      </div>
      {sessions.length === 0 ? (
        <EmptyState connected={connected} />
      ) : (
        <>
          {/* Only the active queue lives in the main list; when every session is
              approved this is empty, so skip the grid element entirely rather
              than render a zero-row `.cards` above the approved section. */}
          {active.length > 0 && (
            <main className="cards">
              {active.map((session, index) => (
                <SessionCard key={session.id} session={session} index={index} now={now} />
              ))}
            </main>
          )}
          {approved.length > 0 && <ApprovedSection sessions={approved} now={now} />}
        </>
      )}
    </div>
  );
}

/**
 * Approved sessions, collapsed by default behind an `approved (n)` heading (D4):
 * declutters the main list while keeping finished plans one tap away. Reuses the
 * activity panel's disclosure idiom (button + aria-expanded + caret + useState)
 * and the same `SessionCard` rows, so an approved plan opens read-only from here
 * (and is the only place it opens — the switcher no longer lists it).
 */
function ApprovedSection({ sessions, now }: { sessions: LiveSession[]; now: number }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="approved-group" aria-label="approved sessions">
      <button
        type="button"
        className="approved-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="approved-group-word">approved</span>
        <span className="approved-count">{sessions.length}</span>
        <span className="approved-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="cards approved-cards">
          {sessions.map((session, index) => (
            <SessionCard key={session.id} session={session} index={index} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

function SessionCard({
  session,
  index,
  now,
}: {
  session: LiveSession;
  index: number;
  now: number;
}) {
  const unread = unreadCount(session.id, session.revision) > 0;
  const href = `/s/${session.id}`;
  const style = { ...accentStyle(session.id), "--i": index } as CSSProperties;
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <a className="card" href={href} style={style} onClick={onClick}>
      {session.changedAt !== undefined && (
        <span key={session.changedAt} className="card-flash" aria-hidden="true" />
      )}
      <div className="card-top">
        <h2 className="card-title">{session.title}</h2>
        {unread && <span className="badge">r{session.revision} unread</span>}
      </div>
      <p className="card-where" title={session.repo}>
        {repoName(session.repo)}
        {session.branch !== "" && <span className="card-branch"> · {session.branch}</span>}
      </p>
      <div className="card-meta">
        <span className="card-sig" aria-hidden="true">
          ▍
        </span>
        <StatusChip
          status={session.status}
          openQuestions={session.openQuestions}
          latestActivity={session.latestActivity}
        />
        <AgentDot
          status={session.status}
          parked={session.parked}
          lastContactAt={session.lastContactAt}
          now={now}
        />
        <span className="card-time">{relativeTime(session.updatedAt, now)}</span>
      </div>
    </a>
  );
}

function EmptyState({ connected }: { connected: boolean }) {
  return (
    <main className="empty">
      <p className="empty-title">no sessions on the codec</p>
      <p className="empty-body">
        From an agent session, run <code>otacon start --title &lt;feature&gt;</code> — its review
        card appears here the moment it registers.
      </p>
      {!connected && <p className="empty-offline">daemon unreachable — is otacond running?</p>}
    </main>
  );
}
