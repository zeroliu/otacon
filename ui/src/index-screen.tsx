// The Index — the phone bookmark (DESIGN.md §10): one card per session,
// status chip, unread badge, last activity, session accent. Live over SSE.

import type { CSSProperties, MouseEvent } from "react";
import { useEffect, useState } from "react";
import { accentStyle } from "./accent";
import type { LiveSession } from "./api";
import { useSessions } from "./api";
import { LinkState, StatusChip } from "./chip";
import { relativeTime, repoName } from "./format";
import { navigate } from "./router";
import { seenRevision } from "./seen";

/** Re-render every `ms` so "3m ago" stays honest while the page idles. */
function useTick(ms: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

export function IndexScreen() {
  const { sessions, connected } = useSessions();
  useTick(30_000);
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
            <SessionCard key={session.id} session={session} index={index} />
          ))}
        </main>
      )}
    </div>
  );
}

function SessionCard({ session, index }: { session: LiveSession; index: number }) {
  const unread = session.revision > seenRevision(session.id);
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
        <StatusChip status={session.status} />
        <span className="card-time">{relativeTime(session.updatedAt)}</span>
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
