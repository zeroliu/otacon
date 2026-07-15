import type { ReviewThread } from "./model.js";

export interface ReviewConversation {
  root: ReviewThread;
  turns: ReviewThread[];
}

/** Fold a flat durable turn list into root conversations without dropping orphans. */
export function groupReviewThreads(threads: ReviewThread[]): ReviewConversation[] {
  const groups: ReviewConversation[] = [];
  const byRoot = new Map<string, ReviewConversation>();
  for (const thread of threads) {
    if (thread.replyTo !== undefined) continue;
    const group = { root: thread, turns: [thread] };
    groups.push(group);
    byRoot.set(thread.id, group);
  }
  for (const thread of threads) {
    if (thread.replyTo === undefined) continue;
    const group = byRoot.get(thread.replyTo);
    if (group === undefined) groups.push({ root: thread, turns: [thread] });
    else group.turns.push(thread);
  }
  for (const group of groups) {
    group.turns.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }
  return groups;
}

export function conversationIsUnresolved(conversation: ReviewConversation): boolean {
  return conversation.turns.some((thread) => thread.response === undefined) ||
    conversation.turns.some((thread) => thread.codeActionStatus !== undefined && thread.codeActionStatus !== "completed");
}
