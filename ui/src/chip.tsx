import type { SessionStatus } from "./api";

// DESIGN.md §10 status chips. "questions pending" is derived state that
// arrives with the ask/answer flow (M4); until then chips map status 1:1.
const CHIPS: Record<SessionStatus, { label: string; tone: string }> = {
  draft: { label: "agent drafting", tone: "draft" },
  in_review: { label: "awaiting your review", tone: "await" },
  revising: { label: "agent revising", tone: "revise" },
  approved: { label: "approved", tone: "approved" },
};

export function StatusChip({ status }: { status: SessionStatus }) {
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
