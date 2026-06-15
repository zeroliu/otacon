// The shared "session is over" split (DESIGN.md §7, §10, §12): one React-free
// source of truth for active-vs-over, so the switcher (which hides over
// sessions) and the home list (which parks them in a collapsed section) can
// never disagree about what is hidden. Mirrors the single-source rule the
// status surfaces already follow (questionsPending in chip.tsx) — derive once,
// render on every face. Typed on `{ status }` alone (not LiveSession) so it
// stays out of the DOM-bound api.ts module and the root typecheck program
// never pulls that in.

import { TERMINAL_STATUSES, type SessionStatus } from "../shared/types.js";

const TERMINAL = new Set<SessionStatus>(TERMINAL_STATUSES);

/**
 * A session is over once it reaches a terminal state (DESIGN.md §12:
 * `approved`/`implemented`/`implement_failed`): it drops out of the switcher,
 * sits in home's collapsed section, and — caught live — sends the review screen
 * home. `implementing` is deliberately NOT terminal: the agent is still on the
 * line building, so that session stays active everywhere. Keyed off the shared
 * TERMINAL_STATUSES set so every surface (here, the app guard, the CLI
 * resolver) agrees on "done".
 */
export function isOver(status: SessionStatus): boolean {
  return TERMINAL.has(status);
}

export interface ApprovalSplit<T> {
  /** Still in play (draft / in_review / revising / implementing): switcher + home main list. */
  active: T[];
  /** Over sessions (the terminal set), kept reachable in home's collapsed section. */
  over: T[];
}

/**
 * Partition sessions into active vs over, preserving the caller's order in
 * both lists (the index and switcher already sort by activity) and never
 * dropping or duplicating a session.
 */
export function partitionByApproval<T extends { status: SessionStatus }>(
  sessions: T[],
): ApprovalSplit<T> {
  const active: T[] = [];
  const over: T[] = [];
  for (const session of sessions) {
    (isOver(session.status) ? over : active).push(session);
  }
  return { active, over };
}
