// The sticky session header (session registry and switcher, review UI): one always-present masthead
// pinned to `top: 0` that compacts on scroll and re-expands at the top. It
// subsumes the old `.topbar` (back + switcher) and the scroll-away
// `SessionHead` hero. Expanded it carries the full identity — title, revision,
// repo/branch, status, agent + link dots — plus the session switcher, the
// clean⇄diff toggle, and Approve; scrolled past a small threshold it collapses
// the detail rows to a tight one-line bar (DECISIONS.md "Sticky header: one
// element compacts on scroll"). Because it is a single persistent element
// there is no second condensed copy to gate — a dropped scroll frame merely
// leaves it expanded, still fully usable. On phone it stays lean: title +
// switcher chips and the clean⇄diff toggle only; the revision and Approve fold
// away — Approve to the fixed bottom bar (review UI — never shown in two places).

import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import type { LiveSession } from "../api";
import { AgentDot, LinkState, StatusChip } from "../chip";
import { relativeTime, repoName } from "../format";
import { navigate } from "../router";
import { SessionSwitcher } from "../switcher";
import type { ReviewView } from "./banner";
import { ViewToggle } from "./banner";
import { nextCompact } from "./compact";

/**
 * Whether the header should be compact, tracked from window scroll and
 * rAF-throttled (like the selection reposition) so it never janks per frame.
 * Fails safe to expanded: a coalesced or dropped frame just leaves the last
 * state, and the header stays complete.
 */
export function useCompactOnScroll(): boolean {
  const [compact, setCompact] = useState(() => nextCompact(window.scrollY, false));
  useEffect(() => {
    let raf = 0;
    const sync = () => {
      raf = 0;
      setCompact((prev) => nextCompact(window.scrollY, prev));
    };
    const onScroll = () => {
      if (raf === 0) raf = requestAnimationFrame(sync);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll(); // settle the initial state (e.g. a restored scroll position)
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, []);
  return compact;
}

/** The ← sessions affordance — shared with the cleaned/missing/loading shells. */
export function BackLink() {
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

export function ReviewHeader({
  session,
  connected,
  now,
  view,
  onView,
  hasPlan,
  onApprove,
  onDelete,
}: {
  session: LiveSession;
  connected: boolean;
  /** A ticking clock (useNow) so the agent dot + timestamp stay honest. */
  now: number;
  view: ReviewView;
  onView: (view: ReviewView) => void;
  /** A plan exists (r≥1): the clean⇄diff toggle only makes sense then. */
  hasPlan: boolean;
  /**
   * Opens the approve confirm sheet (review UI) — undefined on an approved
   * (ended) session. Click-only: no keyboard shortcut exists, on purpose.
   */
  onApprove?: () => void;
  /** Opens the delete confirm sheet; every session is deletable (review UI). */
  onDelete?: () => void;
}) {
  const compact = useCompactOnScroll();
  return (
    <header className={compact ? "review-header compact" : "review-header"}>
      <div className="rh-bar">
        <BackLink />
        <div className="rh-ident">
          <h1 className="session-title">{session.title}</h1>
          <span className="session-rev">r{session.revision}</span>
        </div>
        {hasPlan && (
          <div className="rh-actions">
            <ViewToggle view={view} onView={onView} />
            {onApprove && (
              <button type="button" className="ctrl-approve" onClick={onApprove}>
                <span aria-hidden="true">✓</span> approve
              </button>
            )}
          </div>
        )}
        <SessionSwitcher current={session.id} />
      </div>
      <div className="rh-detail">
        <p className="session-where" title={session.repo}>
          {repoName(session.repo)}
          {session.branch !== "" && <span> · {session.branch}</span>}
        </p>
        <div className="session-meta">
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
          <LinkState connected={connected} />
          {onDelete && (
            <button type="button" className="session-delete" title="delete session" onClick={onDelete}>
              ✕ delete
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
