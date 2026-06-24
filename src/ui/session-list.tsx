// The reusable session list (app shell): one condensed accent-coded row per
// session — status glyph, agent dot, unread badge — over the live index SSE
// stream. Rendered in two places off the same component: the persistent desktop
// sidebar (≥960px) and the mobile session sheet the ☰ overflow menu opens
// (<960px). Active sessions lead in delivered activity order; over (terminal)
// sessions sit behind a collapsed `approved (n)` disclosure, mirroring the old
// home screen's ApprovedSection so the two surfaces can never disagree about
// what is hidden.

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
import { useState } from "react";
import { accentStyle } from "./accent";
import type { LiveSession } from "./api";
import { useSessions } from "./api";
import { AgentDot } from "./chip";
import { repoName } from "./format";
import { DeleteDialog } from "./review/delete";
import { navigate } from "./router";
import { unreadCount } from "./seen";
import { isOver, partitionByApproval } from "./session-filter";
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
  // The shared split (session-filter): active sessions stay in the main list,
  // over (terminal) ones fall to the collapsed disclosure below — the same
  // partition every session surface reads, so no surface disagrees.
  const { active, over } = partitionByApproval(sessions);
  return (
    <nav className="session-list" aria-label="sessions">
      {active.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          current={session.id === current}
          now={now}
          onNavigate={onNavigate}
        />
      ))}
      {over.length > 0 && (
        <ApprovedRows sessions={over} current={current} now={now} onNavigate={onNavigate} />
      )}
    </nav>
  );
}

/**
 * Over sessions — the terminal set (approved, plus implemented/implement_failed
 * once a build finishes) — collapsed by default behind an `approved (n)`
 * disclosure, mirroring the home screen's ApprovedSection (button + aria-expanded
 * + caret + useState): declutters the live queue while keeping finished plans one
 * tap away, with the same condensed rows.
 */
function ApprovedRows({
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
  const [open, setOpen] = useState(false);
  return (
    <section className="sl-approved" aria-label="approved sessions">
      <button
        type="button"
        className="sl-approved-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sl-approved-word">approved</span>
        <span className="sl-approved-count">{sessions.length}</span>
        <span className="sl-approved-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="sl-approved-rows">
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
  const over = isOver(session.status);
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
          <span className="sl-where" title={session.repo}>
            {repoName(session.repo)}
            {session.branch !== "" && <span className="sl-branch"> · {session.branch}</span>}
          </span>
        </span>
        <AgentDot
          status={session.status}
          parked={session.parked}
          lastContactAt={session.lastContactAt}
          now={now}
          label={false}
        />
        {unread > 0 && (
          <span className="sl-unread" aria-label={`${unread} unread`}>
            ●{unread}
          </span>
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
          approved={over}
          onClose={() => setDeleting(false)}
          // The `removed` SSE frame drops the row; closing state is housekeeping.
          onDeleted={() => setDeleting(false)}
        />
      )}
    </>
  );
}
