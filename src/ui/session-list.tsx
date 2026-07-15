// The reusable session list (app shell): one condensed accent-coded row per
// session — status glyph, agent dot, unread badge — over the live index SSE
// stream. Rendered in two places off the same component: the persistent desktop
// sidebar (≥960px) and the mobile session sheet the ☰ overflow menu opens
// (<960px). The list splits three ways (session-filter `partitionSessions`):
// Plans / Reviews switch below the existing sidebar header. Plan sessions keep
// their active order, followed by an "Open PRs" group
// (terminal sessions whose latest PR is still open), EXPANDED by default and
// counted, so work waiting on review stays visible, then a "Done" group
// (finished work: Save-only approvals, merged/closed PRs, failed builds),
// COLLAPSED by default and UNCOUNTED, decluttering the queue while keeping
// finished plans one tap away. Both collapsible groups render through the one
// SessionGroup component, so the two surfaces can never disagree about what is
// hidden.

import {
  Check,
  CheckCheck,
  CircleX,
  Eye,
  LoaderCircle,
  MessageCircleQuestion,
  TriangleAlert,
} from "lucide-react";
import type { CSSProperties, MouseEvent } from "react";
import { useEffect, useState } from "react";
import { accentStyle } from "./accent";
import type { LiveSession } from "./api";
import { useSessions } from "./api";
import { AgentDot } from "./chip";
import { repoName } from "./format";
import { DeleteDialog } from "./review/delete";
import { navigate } from "./router";
import { unreadCount } from "./seen";
import { partitionReviewSessions, partitionSessionKinds, partitionSessions } from "./session-filter";
import { isTerminalSession } from "../shared/types";
import type { NavIcon } from "./session-status";
import { navState } from "./session-status";
import { useNow } from "./tick";

// nav icon name → lucide component. Named imports only, so Vite tree-shakes the
// rest of the set out of the bundle.
const NAV_ICONS: Record<NavIcon, typeof Check> = {
  answer: MessageCircleQuestion,
  review: Eye,
  working: LoaderCircle,
  stalled: TriangleAlert,
  approved: Check,
  implemented: CheckCheck,
  failed: CircleX,
};

export function SessionList({
  current,
  onNavigate,
}: {
  /** The session being viewed, highlighted in the list (aria-current). */
  current?: string;
  /** Fired after an in-app navigation — lets the mobile session sheet close itself. */
  onNavigate?: () => void;
}) {
  const { sessions } = useSessions();
  // One ticking clock for the whole list, like the index: keeps every row's
  // agent-presence dot honest while the sidebar idles between SSE frames.
  const now = useNow(30_000);
  return <SessionListContents sessions={sessions} current={current} now={now} onNavigate={onNavigate} />;
}

/** Pure-data entry used by the sidebar contract tests and the live wrapper above. */
export function SessionListContents({
  sessions,
  current,
  now,
  onNavigate,
}: {
  sessions: LiveSession[];
  current?: string;
  now: number;
  onNavigate?: () => void;
}) {
  // The shared three-way split (session-filter): active sessions stay in the main
  // list, then a counted/expanded "Open PRs" group, then a collapsed/uncounted
  // "Done" group: the same partition every session surface reads, so no surface
  // disagrees.
  const { plans, reviews } = partitionSessionKinds(sessions);
  const currentKind = sessions.find((session) => session.id === current)?.kind;
  const [mode, setMode] = useState<"plan" | "review">(
    currentKind ?? (plans.length > 0 ? "plan" : "review"),
  );
  useEffect(() => {
    if (currentKind !== undefined) {
      setMode(currentKind);
    } else if (mode === "plan" && plans.length === 0 && reviews.length > 0) {
      setMode("review");
    } else if (mode === "review" && reviews.length === 0 && plans.length > 0) {
      setMode("plan");
    }
  }, [currentKind, mode, plans.length, reviews.length]);
  const { active, prReview, done } = partitionSessions(plans);
  const { active: activeReviews, done: doneReviews } = partitionReviewSessions(reviews);
  return (
    <nav className="session-list" aria-label="sessions">
      <div className="session-kind-switch" role="group" aria-label="session kind">
        <button type="button" aria-pressed={mode === "plan"} onClick={() => setMode("plan")}>Plans</button>
        <button type="button" aria-pressed={mode === "review"} onClick={() => setMode("review")}>Reviews</button>
      </div>
      {mode === "plan" && active.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          current={session.id === current}
          now={now}
          onNavigate={onNavigate}
        />
      ))}
      {mode === "plan" && prReview.length > 0 && (
        <SessionGroup
          key="pr-review"
          label="Open PRs"
          sessions={prReview}
          defaultOpen={true}
          showCount={true}
          current={current}
          now={now}
          onNavigate={onNavigate}
        />
      )}
      {mode === "plan" && done.length > 0 && (
        <SessionGroup
          key="done"
          label="Done"
          sessions={done}
          defaultOpen={false}
          showCount={false}
          current={current}
          now={now}
          onNavigate={onNavigate}
        />
      )}
      {mode === "review" && activeReviews.length > 0 && (
        <SessionGroup
          key="active-reviews"
          label="Active"
          sessions={activeReviews}
          defaultOpen={true}
          showCount={true}
          current={current}
          now={now}
          onNavigate={onNavigate}
        />
      )}
      {mode === "review" && doneReviews.length > 0 && (
        <SessionGroup
          key="done-reviews"
          label="Done"
          sessions={doneReviews}
          defaultOpen={false}
          showCount={false}
          current={current}
          now={now}
          onNavigate={onNavigate}
        />
      )}
    </nav>
  );
}

/**
 * One collapsible group of terminal sessions: the same button + aria-expanded +
 * caret + useState disclosure idiom, holding the condensed rows. Drives both
 * sidebar groups: "Open PRs" (defaultOpen + showCount, so work waiting on review
 * leads and carries a count) and "Done" (collapsed, no count). When `showCount`
 * is false the count span is omitted entirely (no hidden zero), and the
 * aria-label folds the count in only when shown.
 */
function SessionGroup({
  label,
  sessions,
  defaultOpen,
  showCount,
  current,
  now,
  onNavigate,
}: {
  label: string;
  sessions: LiveSession[];
  defaultOpen: boolean;
  showCount: boolean;
  current?: string;
  now: number;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className="sl-group"
      aria-label={showCount ? `${label} sessions (${sessions.length})` : `${label} sessions`}
    >
      <button
        type="button"
        className="sl-group-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sl-group-word">{label}</span>
        {showCount && <span className="sl-group-count">{sessions.length}</span>}
        <span className="sl-group-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="sl-group-rows">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              current={session.id === current}
              now={now}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SessionRow({
  session,
  current,
  now,
  onNavigate,
}: {
  session: LiveSession;
  current: boolean;
  now: number;
  onNavigate?: () => void;
}) {
  const nav = navState(session, now);
  const Icon = NAV_ICONS[nav.icon];
  const unread = unreadCount(session.id, session.revision);
  const href = `/s/${session.id}`;
  // Any session can be deleted (review UI): all deletes permanently remove the
  // home folder (`~/.otacon/sessions/<id>/`). `over` only drives the confirm
  // copy: for a terminal session the durable copy survives elsewhere (the Save
  // copy under plans.dir, or the PR for Implement plans).
  const over = isTerminalSession(session);
  const location = session.kind === "review"
    ? session.review.pullRequest.identity.repository
    : repoName(session.repo);
  const branch = session.kind === "review"
    ? `${session.review.pullRequest.headRepository}:${session.review.pullRequest.headRef}`
    : session.branch;
  const [deleting, setDeleting] = useState(false);
  // Plain left-click navigates in-app (and lets a host close its drawer);
  // modifier/middle clicks fall through to the real href for a new tab/window.
  // The current row no-ops — you are already here.
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    if (!current) navigate(href);
    onNavigate?.();
  };
  return (
    <>
      <a
        className={["sl-row", current && "current", nav.attention && "attention"]
          .filter(Boolean)
          .join(" ")}
        href={href}
        style={accentStyle(session.id) as CSSProperties}
        aria-current={current ? "page" : undefined}
        onClick={onClick}
      >
        <span className={`sl-glyph sl-glyph-${nav.icon}`} aria-label={nav.word}>
          <Icon aria-hidden />
        </span>
        <span className="sl-text">
          <span className="sl-title">{session.title}</span>
          <span className="sl-where" title={session.kind === "review" ? session.prUrl : session.repo}>
            {location}
            {branch !== "" && <span className="sl-branch"> · {branch}</span>}
          </span>
        </span>
        {session.kind === "plan" && session.socratic && (
          <span
            className="session-badge sl-socratic"
            data-mode="socratic"
            aria-label="socratic mode"
            title="Socratic mode"
          >
            S
          </span>
        )}
        {unread > 0 && (
          <span className="sl-unread" aria-label={`${unread} unread`}>
            ●{unread}
          </span>
        )}
        {/* Right-most flow element: on hover-capable devices the delete ✕ fades in
            over the dot's slot (see styles.css), so render it last in flow. */}
        {session.kind === "plan" && (
          <AgentDot
            status={session.status}
            parked={session.parked}
            lastContactAt={session.lastContactAt}
            now={now}
            label={false}
          />
        )}
        <button
          type="button"
          className="sl-delete"
          aria-label={`delete session ${session.title}`}
          title="delete session"
          // The row is a link: stop the click from navigating into it.
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDeleting(true);
          }}
        >
          ✕
        </button>
      </a>
      {deleting && (
        <DeleteDialog
          sessionId={session.id}
          sessionKind={session.kind}
          approved={over}
          onClose={() => setDeleting(false)}
          // The `removed` SSE frame drops the row; closing state is housekeeping.
          onDeleted={() => setDeleting(false)}
        />
      )}
    </>
  );
}
