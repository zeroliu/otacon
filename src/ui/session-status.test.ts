// Pins the side-nav status derivation the sidebar list reads: unanswered grill
// questions outrank the agent-side status (the "answer" icon, attention), an
// in_review session asks for review, a working session spins only while the
// agent is on the line (else it warns), and terminal statuses map to their
// static outcome icons. Construct minimal LiveSession fixtures (navState reads
// only status / openQuestions / parked / lastContactAt) so the rest is
// cast-filled. The live/stalled split uses the real agentLive threshold (5 min).

import { describe, expect, test } from "bun:test";
import type { LiveSession, SessionStatus } from "./api";
import { navState } from "./session-status";

const NOW = 1_700_000_000_000;

// Only the four fields navState touches are set; the cast keeps the fixture lean.
function session(fields: {
  status: SessionStatus;
  openQuestions?: number;
  parked?: boolean;
  lastContactAt?: number;
}): LiveSession {
  return {
    kind: "plan",
    status: fields.status,
    openQuestions: fields.openQuestions ?? 0,
    parked: fields.parked ?? false,
    lastContactAt: fields.lastContactAt,
  } as LiveSession;
}

describe("navState", () => {
  test("review sessions use their own working, reviewing, and done language", () => {
    const review = (status: "working" | "reviewing" | "done") => ({
      kind: "review",
      status,
    }) as LiveSession;
    expect(navState(review("working"), NOW)).toEqual({
      icon: "working", word: "building review", attention: false,
    });
    expect(navState(review("reviewing"), NOW)).toEqual({
      icon: "review", word: "reviewing", attention: true,
    });
    expect(navState(review("done"), NOW)).toEqual({
      icon: "implemented", word: "done", attention: false,
    });
  });
  test("pending questions on a live working status → answer, attention", () => {
    // draft is live, so openQuestions > 0 flips it to answer-needed, NOT the
    // working spinner.
    expect(navState(session({ status: "draft", openQuestions: 2 }), NOW)).toEqual({
      icon: "answer",
      word: "answer needed",
      attention: true,
    });
  });

  test("pending questions while implementing → answer, attention", () => {
    // implementing counts as live (a build blocker can post `otacon ask`), so a
    // pending question outranks the build spinner.
    expect(navState(session({ status: "implementing", openQuestions: 1 }), NOW)).toEqual({
      icon: "answer",
      word: "answer needed",
      attention: true,
    });
  });

  test("in_review → review, attention", () => {
    expect(navState(session({ status: "in_review" }), NOW)).toEqual({
      icon: "review",
      word: "review needed",
      attention: true,
    });
  });

  test("each working status with a live agent → working + its phase word", () => {
    const words = {
      draft: "drafting",
      revising: "revising",
      finalizing: "finalizing",
      implementing: "implementing",
    } as const;
    for (const status of ["draft", "revising", "finalizing", "implementing"] as const) {
      // parked:true is live regardless of lastContactAt.
      expect(navState(session({ status, parked: true }), NOW)).toEqual({
        icon: "working",
        word: words[status],
        attention: false,
      });
    }
  });

  test("recent contact counts as live (under the 5-min threshold)", () => {
    expect(navState(session({ status: "revising", lastContactAt: NOW }), NOW)).toEqual({
      icon: "working",
      word: "revising",
      attention: false,
    });
  });

  test("working status with an offline agent → stalled", () => {
    // Not parked and last contact is 10 min back (past the 5-min threshold).
    expect(
      navState(session({ status: "draft", parked: false, lastContactAt: NOW - 10 * 60_000 }), NOW),
    ).toEqual({ icon: "stalled", word: "stalled", attention: false });
  });

  test("working status with no contact at all → stalled", () => {
    expect(navState(session({ status: "implementing", parked: false }), NOW)).toEqual({
      icon: "stalled",
      word: "stalled",
      attention: false,
    });
  });

  test("terminal statuses map to their static outcome icons, no attention", () => {
    expect(navState(session({ status: "approved" }), NOW)).toEqual({
      icon: "approved",
      word: "approved",
      attention: false,
    });
    expect(navState(session({ status: "implemented" }), NOW)).toEqual({
      icon: "implemented",
      word: "implemented",
      attention: false,
    });
    expect(navState(session({ status: "implement_failed" }), NOW)).toEqual({
      icon: "failed",
      word: "failed",
      attention: false,
    });
  });

  test("pending questions never reach a terminal session", () => {
    // questionsPending excludes terminal statuses, so openQuestions can't flip
    // an approved session to answer-needed; it keeps its outcome icon.
    expect(navState(session({ status: "approved", openQuestions: 3 }), NOW)).toEqual({
      icon: "approved",
      word: "approved",
      attention: false,
    });
  });
});
