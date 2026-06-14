// The Index — the phone bookmark (DESIGN.md §10): one card per session,
// status chip, unread badge, last activity, session accent. Live over SSE.

import type { CSSProperties, MouseEvent } from "react";
import { useState } from "react";
import { accentStyle } from "./accent";
import type { LiveSession } from "./api";
import { useSessions } from "./api";
import { AgentDot, LinkState, StatusChip } from "./chip";
import { relativeTime, repoName } from "./format";
import { DeleteDialog } from "./review/delete";
import { navigate } from "./router";
import { unreadCount } from "./seen";
import { useNow } from "./tick";

export function IndexScreen() {
  const { sessions, connected } = useSessions();
  // One ticking clock for the whole list: keeps "3m ago" and every card's
  // agent-presence dot honest while the page idles between SSE frames.
  const now = useNow(30_000);
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
          sessions <span className="list-count">{sessions.length}</span>
        </span>
        <span className="freq">140.85</span>
      </div>
      {sessions.length === 0 ? (
        <EmptyState connected={connected} />
      ) : (
        <main className="cards">
          {sessions.map((session, index) => (
            <SessionCard key={session.id} session={session} index={index} now={now} />
          ))}
        </main>
      )}
    </div>
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
  // Pending (non-approved) sessions can be deleted from the list to clear
  // abandoned drafts (DESIGN.md §10); approved ones are `otacon clean`'s job.
  const pending = session.status !== "approved";
  const [deleting, setDeleting] = useState(false);
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <>
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
          {pending && (
            <button
              type="button"
              className="card-delete"
              aria-label={`delete session ${session.title}`}
              title="delete session"
              // The card is a link: stop the click from navigating into it.
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setDeleting(true);
              }}
            >
              ✕
            </button>
          )}
        </div>
      </a>
      {deleting && (
        <DeleteDialog
          sessionId={session.id}
          onClose={() => setDeleting(false)}
          // The `removed` SSE frame drops the card; closing state is housekeeping.
          onDeleted={() => setDeleting(false)}
        />
      )}
    </>
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
