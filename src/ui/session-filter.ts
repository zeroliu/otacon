// The shared session split (session registry and switcher, review UI, approval and archive lifecycle): one React-free
// source of truth, so the switcher (which hides over sessions) and the sidebar
// (which parks them in collapsed groups) can never disagree about what is hidden.
// Mirrors the single-source rule the status surfaces already follow
// (questionsPending in chip.tsx): derive once, render on every face.
//
// `isOver` is the binary active-vs-terminal divider every surface still reads.
// `partitionSessions` layers a THREE-way split on top (active, PR review, done)
// that keys off the PR, not the status alone: a terminal session whose latest PR
// is still open lands in PR review, while a NON-terminal session that carries a
// prUrl (a reopened amendment) stays active, not in PR review. See
// `partitionSessions`/`prInReview` for the exact rule.
//
// Typed on a small structural shape (status + prUrl + prState), not LiveSession,
// so it stays out of the DOM-bound api.ts module and the root typecheck program
// never pulls that in.

import {
  isTerminalSession,
  TERMINAL_STATUSES,
  type AnySessionStatus,
  type PlanRegistrySession,
  type ReviewRegistrySession,
  type SessionStatus,
} from "../shared/types.js";

const TERMINAL = new Set<AnySessionStatus>(TERMINAL_STATUSES);

/**
 * A session is over once it reaches a terminal state (approval and archive lifecycle:
 * `approved`/`implemented`/`implement_failed`): it drops out of the switcher,
 * sits in home's collapsed section, and — caught live — sends the review screen
 * home. `implementing` is deliberately NOT terminal: the agent is still on the
 * line building, so that session stays active everywhere. Keyed off the shared
 * TERMINAL_STATUSES set so every surface (here, the app guard, the CLI
 * resolver) agrees on "done".
 */
export function isOver(status: AnySessionStatus): boolean {
  return TERMINAL.has(status);
}

/** Only plan sessions use the live active -> terminal redirect to the index. */
export function shouldRedirectAfterTerminalTransition(
  session: { kind: "plan" | "review"; status: AnySessionStatus },
  sawActive: boolean,
): boolean {
  return session.kind === "plan" && sawActive && isOver(session.status);
}

export function partitionSessionKinds<T extends { kind: "plan" | "review" }>(sessions: T[]): {
  plans: Array<T & PlanRegistrySession>;
  reviews: Array<T & ReviewRegistrySession>;
} {
  const plans: Array<T & PlanRegistrySession> = [];
  const reviews: Array<T & ReviewRegistrySession> = [];
  for (const session of sessions) {
    if (session.kind === "review") reviews.push(session as T & ReviewRegistrySession);
    else plans.push(session as T & PlanRegistrySession);
  }
  return { plans, reviews };
}

/** Review navigation keeps completed reading sessions visible under Done. */
export function partitionReviewSessions<T extends ReviewRegistrySession>(sessions: T[]): {
  active: T[];
  done: T[];
} {
  const active: T[] = [];
  const done: T[] = [];
  for (const session of sessions) {
    (isTerminalSession(session) ? done : active).push(session);
  }
  return { active, done };
}

/**
 * A terminal session whose latest PR is still in play: it has a PR URL and that
 * PR is open (or not yet probed: an absent prState on a PR-bearing session
 * counts as still open, per types.ts). Keyed off the PR, NOT the status, so the
 * sidebar can park "waiting on review" PRs separately from finished work.
 *
 * Note the `isOver` gate: a NON-terminal session that carries a prUrl (e.g. a
 * reopened amendment still `revising`/`implementing` over an earlier PR) is NOT
 * in PR review. It stays in the active list. Only terminal sessions can reach
 * PR review or done.
 */
export function prInReview<
  T extends { status: SessionStatus; prUrl?: string; prState?: "open" | "merged" | "closed" },
>(s: T): boolean {
  return (
    isOver(s.status) &&
    typeof s.prUrl === "string" &&
    s.prState !== "merged" &&
    s.prState !== "closed"
  );
}

export interface SessionGroups<T> {
  /**
   * Still in play: NOT terminal (draft / in_review / revising / finalizing /
   * implementing), regardless of any prUrl. The switcher + home main list. A
   * reopened amendment that carries a prUrl but is non-terminal stays here, not
   * in PR review.
   */
  active: T[];
  /**
   * Terminal sessions whose latest PR is open or not yet probed (see
   * `prInReview`): "waiting on review", kept in their own expanded, counted
   * group so they stay visible.
   */
  prReview: T[];
  /**
   * Terminal sessions that are NOT in PR review: approved Save-only plans with no
   * PR, merged or closed PRs, and the rare failed build. Finished work, parked in
   * a collapsed, uncounted group.
   */
  done: T[];
}

/**
 * Partition sessions into three groups (active, PR review, done), keying off
 * the PR rather than the status alone. Every session lands in exactly one group,
 * the caller's incoming order is preserved within each group (the index and
 * switcher already sort by activity), and no session is dropped or duplicated.
 *
 * The split: a non-terminal session is always `active` (even with a prUrl, the
 * reopened-amendment case); a terminal session is `prReview` when `prInReview`
 * holds, otherwise `done`.
 */
export function partitionSessions<
  T extends { status: SessionStatus; prUrl?: string; prState?: "open" | "merged" | "closed" },
>(sessions: T[]): SessionGroups<T> {
  const active: T[] = [];
  const prReview: T[] = [];
  const done: T[] = [];
  for (const session of sessions) {
    if (!isOver(session.status)) active.push(session);
    else if (prInReview(session)) prReview.push(session);
    else done.push(session);
  }
  return { active, prReview, done };
}
