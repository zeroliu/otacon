// The /s/:id shell: session header in the session's accent color, live over
// its SSE stream. Plan rendering, threads, and diffs land here in M2b/M2c.

import type { MouseEvent } from "react";
import { useEffect } from "react";
import { accentStyle } from "./accent";
import { useSession } from "./api";
import { LinkState, StatusChip } from "./chip";
import { relativeTime, repoName } from "./format";
import { navigate } from "./router";
import { markSeen } from "./seen";

function BackLink() {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    navigate("/");
  };
  return (
    <a className="backlink" href="/" onClick={onClick}>
      ← sessions
    </a>
  );
}

export function SessionScreen({ id }: { id: string }) {
  const { session, missing, connected } = useSession(id);

  const revision = session?.revision;
  useEffect(() => {
    if (session && revision !== undefined) markSeen(session.id, revision);
  }, [session, revision]);

  if (missing) {
    return (
      <div className="page">
        <BackLink />
        <main className="empty">
          <p className="empty-title">unknown session</p>
          <p className="empty-body">
            The daemon has no session <code>{id}</code>. It may have been cleaned, or the link is
            stale.
          </p>
        </main>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="page">
        <BackLink />
        <p className="loading">connecting…</p>
      </div>
    );
  }

  return (
    <div className="page" style={accentStyle(session.id)}>
      <BackLink />
      <header className="session-head">
        <div className="session-head-top">
          <h1 className="session-title">{session.title}</h1>
          <span className="session-rev">r{session.revision}</span>
        </div>
        <p className="session-where" title={session.repo}>
          {repoName(session.repo)}
          {session.branch !== "" && <span> · {session.branch}</span>}
        </p>
        <div className="session-meta">
          <StatusChip status={session.status} />
          <span className="card-time">{relativeTime(session.updatedAt)}</span>
          <LinkState connected={connected} />
        </div>
      </header>
      <main className="review-stub">
        <p className="stub-line">// review screen lands in M2b</p>
        <p>
          {session.revision === 0
            ? "No revision has been submitted yet — the agent is still drafting."
            : `Revision ${session.revision} is stored on the daemon.`}{" "}
          Plan rendering, threads, and diffs arrive with M2b/M2c.
        </p>
        <p className="stub-id">
          session <code>{session.id}</code>
        </p>
      </main>
    </div>
  );
}
