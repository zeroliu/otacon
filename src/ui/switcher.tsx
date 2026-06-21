// The persistent session switcher in the review header (session registry and switcher):
// a dropdown on desktop, horizontally scrollable chips on a phone —
// `auth-refactor ●2 │ search-index ✋awaiting` — each chip in its session's
// accent so rapid phone switching can't post feedback to the wrong plan.
// Rides the same index SSE stream as the home screen (snapshot + session +
// removed frames), so chips appear, re-badge, and vanish live.

import type { MouseEvent } from "react";
import { accentStyle } from "./accent";
import type { LiveSession } from "./api";
import { useSessions } from "./api";
import { AgentDot } from "./chip";
import { navigate } from "./router";
import { unreadCount } from "./seen";
import { isOver, partitionByApproval } from "./session-filter";
import { stateOf } from "./session-status";
import { useNow } from "./tick";

export function SessionSwitcher({ current }: { current: string }) {
  const { sessions: byActivity } = useSessions();
  const now = useNow(30_000);
  // Over sessions (the terminal set) drop from the switcher entirely, so a
  // finished plan stops cluttering the strip you switch through, including the
  // one you are on (D1). `implementing` is NOT
  // over, so a building session keeps its chip live. The split is shared with
  // home so the two surfaces can never disagree about what is hidden.
  const { active } = partitionByApproval(byActivity);
  // `current` is absent from the visible list when it was cleaned (gone from the
  // registry) OR is itself over (opened from home — its chip is now hidden).
  // Either way the controlled select has no matching option and would render
  // blank (selectedIndex -1), so `gone` makes it fall back to a labeled
  // placeholder. Both facts come from the one `currentSession` lookup: it's
  // absent from `active` exactly when it's missing from the registry or over.
  const currentSession = byActivity.find((s) => s.id === current);
  const gone = !currentSession || isOver(currentSession.status);
  // The `[` / `]` shortcut no longer mounts here — it moved to the app shell
  // (the one element on every route), so it's live on the welcome/settings panes
  // too and there's a single mount (DECISIONS "Session nav shortcut moves to the
  // app shell"). The switcher stays the interim <960px session-switching face.
  // Render nothing only when the registry is genuinely empty. An all-over
  // registry still has a current to anchor: the placeholder must show, so the
  // switcher doesn't vanish out from under the one over session you opened from
  // home. Keying on `byActivity` (not `active`) keeps the
  // placeholder reachable instead of short-circuiting before it.
  if (byActivity.length === 0) return null;
  // The chip you are on leads the strip: the "you are here"
  // anchor never scrolls out of reach; the rest keep their activity order.
  // Unread is computed once here for both faces (select + chips); the entry
  // you are on never wears a badge — you are reading it.
  const entries = [
    ...active.filter((s) => s.id === current),
    ...active.filter((s) => s.id !== current),
  ].map((session) => ({
    session,
    unread: session.id === current ? 0 : unreadCount(session.id, session.revision),
  }));

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
                {currentSession
                  ? `${currentSession.title} · ${stateOf(currentSession).word}`
                  : "cleaned session"}
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
      {/* Compact presence dot (no label — the chip is tight); over states hide it. */}
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
