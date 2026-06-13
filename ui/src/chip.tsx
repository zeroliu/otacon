import type { SessionStatus } from "./api";

// DESIGN.md §10 status chips. "questions pending" is derived state, not a
// stored status: it lights while unanswered agent grill questions exist
// (summary.openQuestions > 0) on a live session — answering is the user's
// move, so it outranks the agent-side statuses until the session is over.
const CHIPS: Record<SessionStatus, { label: string; tone: string }> = {
  draft: { label: "agent drafting", tone: "draft" },
  in_review: { label: "awaiting your review", tone: "await" },
  revising: { label: "agent revising", tone: "revise" },
  approved: { label: "approved", tone: "approved" },
};

/**
 * The §10 derivation, single-sourced for every status surface (this chip, the
 * switcher's glyphs): unanswered grill questions are the user's move, so they
 * outrank the agent-side statuses until the session is over.
 */
export function questionsPending(status: SessionStatus, openQuestions: number): boolean {
  return status !== "approved" && openQuestions > 0;
}

export function StatusChip({
  status,
  openQuestions = 0,
}: {
  status: SessionStatus;
  /** Unanswered agent questions (summary.openQuestions); flips the chip. */
  openQuestions?: number;
}) {
  if (questionsPending(status, openQuestions)) {
    return (
      <span className="chip chip-questions" data-status="questions_pending">
        <span className="chip-dot" aria-hidden="true" />
        questions pending
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

export function LinkState({ connected }: { connected: boolean }) {
  return (
    <span className={connected ? "link-state is-live" : "link-state"}>
      <span className="link-dot" aria-hidden="true" />
      {connected ? "live" : "offline"}
    </span>
  );
}
