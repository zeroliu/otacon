// The side-nav status indicator derivation, single-sourced so a session's nav
// icon can never disagree with the rules the chips already follow (chip.tsx):
// pending grill questions outrank the agent-side status, and a "working" session
// is only spinning while the agent is actually on the line. Stays React-free:
// it returns a NavIcon name plus a word, and the row maps the name to a lucide
// component (so this file pulls in no icon code).

import type { LiveSession, SessionStatus } from "./api";
import { agentLive, questionsPending } from "./chip";

export type NavIcon =
  | "answer"
  | "review"
  | "working"
  | "stalled"
  | "approved"
  | "implemented"
  | "failed";

export interface NavState {
  icon: NavIcon;
  word: string;
  /** Attention states (your turn): the row gets a brighter background. */
  attention: boolean;
}

// The working statuses (the agent is actively producing the plan or building
// it). A typed map (not a Set) over exactly these keys, so adding a SessionStatus
// without deciding its phase word is a compile error here.
const WORKING_WORDS: Record<"draft" | "revising" | "finalizing" | "implementing", string> = {
  draft: "drafting",
  revising: "revising",
  finalizing: "finalizing",
  implementing: "implementing",
};

function isWorking(status: SessionStatus): status is keyof typeof WORKING_WORDS {
  return status in WORKING_WORDS;
}

export function navState(session: LiveSession, now: number): NavState {
  // questionsPending is the chips' derivation (chip.tsx): it already excludes
  // terminal statuses and counts `implementing` as live, so a build blocker's
  // `otacon ask` lights here too. Answering is the user's move, so it outranks
  // every agent-side status.
  if (questionsPending(session.status, session.openQuestions)) {
    return { icon: "answer", word: "answer needed", attention: true };
  }
  if (session.status === "in_review") {
    return { icon: "review", word: "review needed", attention: true };
  }
  if (isWorking(session.status)) {
    // Spin only while the agent is on the line; if it has gone quiet the work is
    // stalled, not progressing, so warn instead of implying motion.
    if (agentLive(session.parked, session.lastContactAt, now)) {
      return { icon: "working", word: WORKING_WORDS[session.status], attention: false };
    }
    return { icon: "stalled", word: "stalled", attention: false };
  }
  // Terminal: the static outcomes. The switch has no default, so a new terminal
  // status is a compile error until it is mapped.
  switch (session.status) {
    case "approved":
      return { icon: "approved", word: "approved", attention: false };
    case "implemented":
      return { icon: "implemented", word: "implemented", attention: false };
    case "implement_failed":
      return { icon: "failed", word: "failed", attention: false };
  }
}
