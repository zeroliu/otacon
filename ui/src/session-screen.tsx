// The /s/:id review screen: session header in the session's accent color,
// live over its SSE stream, rendering the latest stored revision as the plan
// dossier (DESIGN.md §10). The renderer (markdown + highlighter) is a lazy
// chunk so the index stays light; threads and diffs land in M2c/M3+ — until
// then the header carries no dead Approve/Diff controls (DECISIONS.md
// "Review screen: reading surface only until the verbs exist").

import type { MouseEvent, ReactNode } from "react";
import { Component, lazy, Suspense, useEffect } from "react";
import { accentStyle } from "./accent";
import type { LiveSession } from "./api";
import { useRevision, useSession } from "./api";
import { LinkState, StatusChip } from "./chip";
import { relativeTime, repoName } from "./format";
import { navigate } from "./router";
import { markSeen } from "./seen";

const PlanView = lazy(() => import("./plan/plan-view"));

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

/**
 * Catches a failed plan-view chunk load (offline, or a stale tab whose chunk
 * URLs vanished when the daemon was rebuilt) — and any renderer crash —
 * instead of letting React unmount the whole tree to a blank page. React
 * caches a lazy() rejection, so recovery is a real reload, not a re-render.
 */
class RendererBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="review-wait">
        <p className="wait-line">// renderer unavailable</p>
        <p>
          The plan renderer failed to load — the daemon may have restarted with a new build, or
          the network dropped. <a href="">Reload</a> to fetch the current one.
        </p>
      </main>
    );
  }
}

function ReviewPane({ session }: { session: LiveSession }) {
  const payload = useRevision(session.id, session.revision);

  if (session.revision === 0) {
    return (
      <main className="review-wait">
        <p className="wait-line">// no revision yet</p>
        <p>
          The agent is still drafting. The plan renders here the moment revision 1 passes the
          linter — this screen updates live.
        </p>
      </main>
    );
  }
  if (!payload) {
    return <p className="loading">loading r{session.revision}…</p>;
  }
  return (
    <main className="review">
      <RendererBoundary>
        <Suspense fallback={<p className="loading">loading renderer…</p>}>
          <PlanView markdown={payload.markdown} warnings={payload.warnings} />
        </Suspense>
      </RendererBoundary>
    </main>
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
      <ReviewPane key={session.id} session={session} />
    </div>
  );
}
