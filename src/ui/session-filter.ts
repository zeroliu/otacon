// The shared approval split (DESIGN.md §7, §10): one React-free source of truth
// for active-vs-approved, so the switcher (which hides approved) and the home
// list (which parks approved in a collapsed section) can never disagree about
// what is hidden. Mirrors the single-source rule the status surfaces already
// follow (questionsPending in chip.tsx) — derive once, render on every face.
// Typed on `{ status }` alone (not LiveSession) so it stays out of the DOM-bound
// api.ts module and the root typecheck program never pulls that in.

import type { SessionStatus } from "../shared/types.js";

/**
 * A session is over once approved (DESIGN.md §12): it drops out of the switcher,
 * sits in home's collapsed section, and — caught live — sends the review screen
 * home. Single-sourced here so every surface agrees on "done".
 */
export function isApproved(status: SessionStatus): boolean {
  return status === "approved";
}

export interface ApprovalSplit<T> {
  /** Still in play (draft / in_review / revising): the switcher + home main list. */
  active: T[];
  /** Ended sessions, kept reachable in home's collapsed `approved` section. */
  approved: T[];
}

/**
 * Partition sessions into active vs approved, preserving the caller's order in
 * both lists (the index and switcher already sort by activity) and never
 * dropping or duplicating a session.
 */
export function partitionByApproval<T extends { status: SessionStatus }>(
  sessions: T[],
): ApprovalSplit<T> {
  const active: T[] = [];
  const approved: T[] = [];
  for (const session of sessions) {
    (isApproved(session.status) ? approved : active).push(session);
  }
  return { active, approved };
}
