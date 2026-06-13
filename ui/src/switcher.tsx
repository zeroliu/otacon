// The persistent session switcher in the review header (DESIGN.md §7):
// a dropdown on desktop, horizontally scrollable chips on a phone —
// `auth-refactor ●2 │ search-index ✋awaiting` — each chip in its session's
// accent so rapid phone switching can't post feedback to the wrong plan.
// Rides the same index SSE stream as the home screen (snapshot + session +
// removed frames), so chips appear, re-badge, and vanish live.

import type { MouseEvent } from "react";
import { accentStyle } from "./accent";
import type { LiveSession, SessionStatus } from "./api";
import { useSessions } from "./api";
import { navigate } from "./router";
import { seenRevision } from "./seen";

const GLYPHS: Record<SessionStatus, { glyph: string; word: string }> = {
  draft: { glyph: "✎", word: "drafting" },
  in_review: { glyph: "✋", word: "awaiting" },
  revising: { glyph: "⏳", word: "revising" },
  approved: { glyph: "✓", word: "approved" },
};

function stateOf(session: LiveSession): { glyph: string; word: string } {
  // Same derivation as the status chips: unanswered agent questions are the
  // user's move and outrank the agent-side statuses until the session ends.
  if (session.status !== "approved" && session.openQuestions > 0) {
    return { glyph: "?", word: "questions" };
  }
  return GLYPHS[session.status];
}

/** Revisions this device has not opened yet (●N); the daemon owns no read state. */
function unreadOf(session: LiveSession): number {
  return Math.max(0, session.revision - seenRevision(session.id));
}

export function SessionSwitcher({ current }: { current: string }) {
  const { sessions: byActivity } = useSessions();
  if (byActivity.length === 0) return null;
  // The chip you are on leads the strip (§7's sketch): the "you are here"
  // anchor never scrolls out of reach; the rest keep their activity order.
  const sessions = [
    ...byActivity.filter((s) => s.id === current),
    ...byActivity.filter((s) => s.id !== current),
  ];

  const onSelect = (id: string) => {
    if (id !== current) navigate(`/s/${id}`);
  };

  return (
    <nav className="switcher" aria-label="switch session">
      {/* Desktop: one dropdown in the instrument strip. */}
      <label className="switch-select">
        <span className="switch-label">session</span>
        <span className="baseline-wrap">
          <select
            aria-label="switch session"
            value={current}
            onChange={(event) => onSelect(event.target.value)}
          >
            {sessions.map((session) => {
              const unread = session.id === current ? 0 : unreadOf(session);
              return (
                <option key={session.id} value={session.id}>
                  {session.title} · {stateOf(session).word}
                  {unread > 0 ? ` ●${unread}` : ""}
                </option>
              );
            })}
          </select>
        </span>
      </label>
      {/* Phone: a one-thumb scroll row of accent-coded chips. */}
      <div className="switch-chips" role="list">
        {sessions.map((session) => (
          <SwitchChip key={session.id} session={session} current={session.id === current} />
        ))}
      </div>
    </nav>
  );
}

function SwitchChip({ session, current }: { session: LiveSession; current: boolean }) {
  const { glyph, word } = stateOf(session);
  // The chip you are on never wears an unread badge — you are reading it.
  const unread = current ? 0 : unreadOf(session);
  const href = `/s/${session.id}`;
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    if (!current) navigate(href);
  };
  return (
    <a
      role="listitem"
      className={current ? "switch-chip switch-on" : "switch-chip"}
      href={href}
      style={accentStyle(session.id)}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
    >
      <span className="switch-name">{session.title}</span>
      <span className="switch-state" aria-label={word}>
        {glyph}
      </span>
      {unread > 0 && (
        <span className="switch-unread" aria-label={`${unread} unread`}>
          ●{unread}
        </span>
      )}
    </a>
  );
}
