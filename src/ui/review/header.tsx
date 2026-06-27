// The sticky session header (session registry and switcher, review UI): one always-present masthead
// pinned to `top: 0` that compacts on scroll and re-expands at the top. It
// subsumes the old `.topbar` (back + switcher) and the scroll-away
// `SessionHead` hero. It is a single always-on `.rh-bar`: the identity (title +
// the "- repo · branch" locator), the read-only meta (status pill, agent dot,
// "updated Xm ago"), the delete button, the clean⇄diff toggle and Approve all
// ride one wrapping line (DECISIONS.md "Sticky header: one element compacts on
// scroll"). Compaction only tightens the padding and title size now: there is
// no separate detail row to collapse, so a dropped scroll frame merely leaves
// it in its last state, still fully usable. On phone the bar wraps to keep
// everything visible (including the status pill) except Approve, which folds
// away to the fixed bottom bar (review UI, never shown in two places). The ☰
// button (<960px) opens the shell's mobile session sheet: the overflow menu
// that replaced the old in-header switcher; at ≥960px the sidebar is the list,
// so it's hidden (CSS).

import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import type { LiveSession } from "../api";
import { AgentDot, StatusChip } from "../chip";
import { prNumber, relativeTime, repoName } from "../format";
import { navigate } from "../router";
import { SessionMenuButton } from "../session-sheet";
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
  now,
  view,
  onView,
  hasPlan,
  onApprove,
  onDelete,
}: {
  session: LiveSession;
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
          {/* The "- repo · branch" locator: muted/mono, ellipsizes after the
              title so identity stays readable as the bar narrows. */}
          <span className="rh-loc" title={session.repo}>
            {" - "}
            {repoName(session.repo)}
            {session.branch !== "" && <span> · {session.branch}</span>}
          </span>
        </div>
        {/* The read-only meta, grouped so it wraps as one unit: status pill +
            agent dot + "updated Xm ago". Visible at every breakpoint. */}
        <div className="rh-meta">
          <StatusChip
            status={session.status}
            openQuestions={session.openQuestions}
            latestActivity={session.latestActivity}
          />
          {session.socratic && (
            <span
              className="session-badge"
              data-mode="socratic"
              title="Socratic mode: free-text grill, decisions you reason yourself"
            >
              socratic
            </span>
          )}
          <AgentDot
            status={session.status}
            parked={session.parked}
            lastContactAt={session.lastContactAt}
            now={now}
          />
          <span className="card-time">{relativeTime(session.updatedAt, now)}</span>
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
        {onDelete && (
          <button type="button" className="session-delete" title="delete session" onClick={onDelete}>
            ✕ delete
          </button>
        )}
        {/* The <960px overflow menu: opens the shell's bottom-sheet session list
            (the switcher's replacement). Hidden at ≥960px, where the sidebar is
            the list (CSS). Sits where the switcher used to, at the bar's end. */}
        <SessionMenuButton className="rh-menu" />
      </div>
      {/* The implementation locator: a quiet second row carrying the build's
          branch, its (ellipsized) worktree path, and a PR badge, only once a
          build has been approved (`session.impl`). Hidden while compact so a
          dropped scroll frame can't leave it half-shown, and so plan-review
          sessions (no impl) gain zero clutter. */}
      {session.impl && !compact && (
        <div className="rh-impl">
          <span className="rh-impl-branch" title={session.impl.branch}>
            {session.impl.branch}
          </span>
          <span className="rh-impl-worktree" title={session.impl.worktree}>
            {session.impl.worktree}
          </span>
          {session.prUrl && (
            <a
              className="pr-badge"
              data-state={session.prState ?? "open"}
              href={session.prUrl}
              target="_blank"
              rel="noreferrer"
              title={`pull request ${prNumber(session.prUrl) ?? ""} (${session.prState ?? "open"})`}
            >
              {prNumber(session.prUrl) ?? "PR"}
            </a>
          )}
        </div>
      )}
    </header>
  );
}
