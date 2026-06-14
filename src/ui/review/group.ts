// Fold a flat thread list into rail units (DESIGN.md §9 follow-ups): a comment
// or a root question is one unit; a follow-up question (carrying `replyTo`) is
// not its own top-level entry — it collapses under its root, so a conversation
// renders once as a card, never twice (once in the card, once as a loose entry).
// Pure so the rail's grouping is unit-tested without a DOM.

import type { Thread } from "../../shared/types.js";

type QuestionThread = Extract<Thread, { kind: "question" }>;

export interface ThreadGroup {
  /** The top-level thread: a comment, or a root question. */
  root: Thread;
  /**
   * Follow-up turns under a root question, oldest first (by createdAt); always
   * empty for comments and for a question with no follow-ups.
   */
  followups: QuestionThread[];
}

/** True when a thread is a follow-up (a question linked to a root). */
function isFollowup(thread: Thread): thread is QuestionThread & { replyTo: string } {
  return thread.kind === "question" && thread.replyTo !== undefined;
}

/**
 * Group threads into rail units, preserving the input's (oldest-first) order of
 * roots. Follow-ups fold under their root's `followups`, ordered by createdAt; a
 * follow-up whose root is missing — or, only via a corrupt threads.json, points
 * at a comment — degrades to its own unit rather than vanishing (DESIGN.md §4:
 * kept, never silently dropped). Only question roots are valid attach targets.
 */
export function groupThreads(threads: Thread[]): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  const byRoot = new Map<string, ThreadGroup>();
  for (const thread of threads) {
    if (isFollowup(thread)) continue;
    const group: ThreadGroup = { root: thread, followups: [] };
    groups.push(group);
    if (thread.kind === "question") byRoot.set(thread.id, group); // comments can't be replied to
  }
  for (const thread of threads) {
    if (!isFollowup(thread)) continue;
    const group = byRoot.get(thread.replyTo);
    if (group) group.followups.push(thread);
    else groups.push({ root: thread, followups: [] }); // root gone/not a question: never drop
  }
  for (const group of groups) {
    group.followups.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return groups;
}
