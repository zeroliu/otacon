import type { ActivityNote, SessionStatus } from "./api";
import { isOver } from "./session-filter";

// DESIGN.md §10 status chips. "questions pending" is derived state, not a
// stored status: it lights while unanswered agent grill questions exist
// (summary.openQuestions > 0) on a live session — answering is the user's
// move, so it outranks the agent-side statuses until the session is over. The
// `draft` chip is special-cased below (activity-driven) rather than living
// here, so it carries no fixed label.
const CHIPS: Record<Exclude<SessionStatus, "draft">, { label: string; tone: string }> = {
  in_review: { label: "awaiting your review", tone: "await" },
  revising: { label: "agent revising", tone: "revise" },
  // comment & approve (§12): the reviewer approved with open comments and sent
  // them to the agent; it is folding them in before the commit. Active work —
  // the breathing dot, like implementing.
  finalizing: { label: "finalizing", tone: "finalizing" },
  approved: { label: "approved", tone: "approved" },
  // The implement lifecycle (DESIGN.md §12): `implementing` is an active,
  // in-progress state (working tone, the only one of the three with a breathing
  // dot — see CSS); the two terminal outcomes read done (green) and failed
  // (caution amber, the palette's error stand-in).
  implementing: { label: "implementing", tone: "implementing" },
  implemented: { label: "implemented", tone: "implemented" },
  implement_failed: { label: "implement failed", tone: "implement-failed" },
};

/**
 * The §10 derivation, single-sourced for every status surface (this chip, the
 * switcher's glyphs): unanswered grill questions are the user's move, so they
 * outrank the agent-side statuses until the session is over. `implementing`
 * counts as live — the orchestrator can post `otacon ask` on a build blocker —
 * so questions pending lights then too; only terminal states suppress it.
 */
export function questionsPending(status: SessionStatus, openQuestions: number): boolean {
  return !isOver(status) && openQuestions > 0;
}

export function StatusChip({
  status,
  openQuestions = 0,
  latestActivity,
}: {
  status: SessionStatus;
  /** Unanswered agent questions (summary.openQuestions); flips the chip. */
  openQuestions?: number;
  /** Newest progress note; drives the `draft` chip's label (DESIGN.md §10, D3). */
  latestActivity?: ActivityNote;
}) {
  if (questionsPending(status, openQuestions)) {
    return (
      <span className="chip chip-questions" data-status="questions_pending">
        <span className="chip-dot" aria-hidden="true" />
        questions pending
      </span>
    );
  }
  // The `draft` chip is activity-driven (D3): the session sits in `draft`
  // through research + drafting before r1 exists, so a fixed "agent drafting"
  // would mislead. Show the latest progress note (CSS-ellipsized so a long note
  // — already ≤cap server-side — can never break the card), or "agent working"
  // until the agent narrates.
  if (status === "draft") {
    const note = latestActivity?.text.trim();
    return (
      <span className="chip chip-draft" data-status="draft">
        <span className="chip-dot" aria-hidden="true" />
        <span className="chip-activity">{note ? note : "agent working"}</span>
      </span>
    );
  }
  const chip = CHIPS[status];
  return (
    <span className={`chip chip-${chip.tone}`} data-status={status}>
      <span className="chip-dot" aria-hidden="true" />
      {chip.label}
    </span>
  );
}

// The live/offline window for the agent dot: must exceed `otacon wait`'s 240s
// park slice so the dot can't blink offline between re-parks (DESIGN.md §6 —
// the daemon refreshes lastContactAt on every park). A guess flagged for
// first-week tuning (§15); 5 min leaves margin while still falling to offline
// when the agent truly stops calling.
const AGENT_LIVE_THRESHOLD_MS = 300_000;

/** Live when parked in `otacon wait`, or when last contact is recent. */
export function agentLive(parked: boolean, lastContactAt: number | undefined, now: number): boolean {
  return parked || (lastContactAt !== undefined && now - lastContactAt < AGENT_LIVE_THRESHOLD_MS);
}

/**
 * The agent-presence dot (DESIGN.md §10, D4): a small live/offline mark beside
 * the status chip — the subtle "is the agent still on the line?" signal, with
 * the chips staying the primary "your turn" cue. Visually distinct from
 * LinkState (the browser↔daemon link) — labelled "agent" vs "link". Hidden on
 * terminal sessions: the agent's job is done there, by design. It stays visible
 * while `implementing` — the agent is on the line building the approved plan.
 */
export function AgentDot({
  status,
  parked,
  lastContactAt,
  now,
  label = true,
}: {
  status: SessionStatus;
  parked: boolean;
  lastContactAt?: number;
  /** A ticking clock (useNow) so the dot stays honest while the screen idles. */
  now: number;
  /** Drop the "agent" text where space is tight (the switcher chips). */
  label?: boolean;
}) {
  if (isOver(status)) return null;
  const live = agentLive(parked, lastContactAt, now);
  return (
    <span
      className={live ? "agent-dot is-live" : "agent-dot"}
      title={live ? "agent is on the line" : "agent is offline"}
    >
      <span className="agent-dot-mark" aria-hidden="true" />
      {label && "agent"}
    </span>
  );
}

export function LinkState({ connected }: { connected: boolean }) {
  return (
    <span
      className={connected ? "link-state is-live" : "link-state"}
      title={connected ? "daemon link live" : "daemon link offline"}
    >
      <span className="link-dot" aria-hidden="true" />
      link
    </span>
  );
}
