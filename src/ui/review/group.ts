// Fold a flat thread list into rail units (threaded review and revision follow-ups): a root
// comment or a root question is one unit; a follow-up turn (comment OR question,
// carrying `replyTo`) is not its own top-level entry — it collapses under its
// root, so a conversation renders once as a card, never twice (once in the card,
// once as a loose entry). Pure so the rail's grouping is unit-tested without a DOM.

import type { Thread } from "../../shared/types.js";

export interface ThreadGroup {
  /** The top-level thread: a root comment, or a root question. */
  root: Thread;
  /**
   * Follow-up turns under a root (same kind as the root), oldest first (by
   * createdAt); empty for a root with no follow-ups.
   */
  followups: Thread[];
}

/** True when a thread is a follow-up (a comment OR question linked to a root). */
function isFollowup(thread: Thread): thread is Thread & { replyTo: string } {
  return thread.replyTo !== undefined;
}

/**
 * Group threads into rail units, preserving the input's (oldest-first) order of
 * roots. Follow-ups fold under their root's `followups`, ordered by createdAt; a
 * follow-up whose root is missing degrades to its own unit rather than vanishing
 * (plan structure, lint, and anchoring: kept, never silently dropped). Both
 * comment and question roots are valid attach targets — ids are unique across
 * kinds (t<n> vs q<n>), so a follow-up attaches to its root regardless of kind.
 */
export function groupThreads(threads: Thread[]): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  const byRoot = new Map<string, ThreadGroup>();
  for (const thread of threads) {
    if (isFollowup(thread)) continue;
    const group: ThreadGroup = { root: thread, followups: [] };
    groups.push(group);
    byRoot.set(thread.id, group); // both comment + question roots are attach targets
  }
  for (const thread of threads) {
    if (!isFollowup(thread)) continue;
    const group = byRoot.get(thread.replyTo);
    if (group) group.followups.push(thread);
    else groups.push({ root: thread, followups: [] }); // root gone: never drop
  }
  for (const group of groups) {
    group.followups.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return groups;
}
