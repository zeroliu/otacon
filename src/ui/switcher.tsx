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
import { AgentDot, questionsPending } from "./chip";
import { navigate } from "./router";
import { unreadCount } from "./seen";
import { useNow } from "./tick";

const GLYPHS: Record<SessionStatus, { glyph: string; word: string }> = {
  draft: { glyph: "✎", word: "drafting" },
  in_review: { glyph: "✋", word: "awaiting" },
  revising: { glyph: "⏳", word: "revising" },
  approved: { glyph: "✓", word: "approved" },
};

function stateOf(session: LiveSession): { glyph: string; word: string } {
  // questionsPending is the status chips' derivation — one source, so the
  // index card and the switcher can never disagree about a session's state.
  if (questionsPending(session.status, session.openQuestions)) {
    return { glyph: "?", word: "questions" };
  }
  return GLYPHS[session.status];
}

export function SessionSwitcher({ current }: { current: string }) {
  const { sessions: byActivity } = useSessions();
  const now = useNow(30_000);
  if (byActivity.length === 0) return null;
  // The chip you are on leads the strip (§7's sketch): the "you are here"
  // anchor never scrolls out of reach; the rest keep their activity order.
  // Unread is computed once here for both faces (select + chips); the entry
  // you are on never wears a badge — you are reading it.
  const entries = [
    ...byActivity.filter((s) => s.id === current),
    ...byActivity.filter((s) => s.id !== current),
  ].map((session) => ({
    session,
    unread: session.id === current ? 0 : unreadCount(session.id, session.revision),
  }));
  // On the cleaned screen `current` was just removed from the registry, so no
  // option matches it — without a placeholder the controlled select would
  // render blank (selectedIndex -1).
  const gone = !byActivity.some((s) => s.id === current);

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
            value={gone ? "" : current}
            onChange={(event) => onSelect(event.target.value)}
          >
            {gone && (
              <option value="" disabled>
                cleaned session
              </option>
            )}
            {entries.map(({ session, unread }) => (
              <option key={session.id} value={session.id}>
                {session.title} · {stateOf(session).word}
                {unread > 0 ? ` ●${unread}` : ""}
              </option>
            ))}
          </select>
        </span>
      </label>
      {/* Phone: a one-thumb scroll row of accent-coded chips. */}
      <div className="switch-chips" role="list">
        {entries.map(({ session, unread }) => (
          <SwitchChip
            key={session.id}
            session={session}
            unread={unread}
            current={session.id === current}
            now={now}
          />
        ))}
      </div>
    </nav>
  );
}

function SwitchChip({
  session,
  unread,
  current,
  now,
}: {
  session: LiveSession;
  /** Pre-derived by the switcher (zero for the current chip). */
  unread: number;
  current: boolean;
  now: number;
}) {
  const { glyph, word } = stateOf(session);
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
      {/* Compact presence dot (no label — the chip is tight); approved hides it. */}
      <AgentDot
        status={session.status}
        parked={session.parked}
        lastContactAt={session.lastContactAt}
        now={now}
        label={false}
      />
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
