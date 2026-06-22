// Pins the condensed status derivation both the switcher and the sidebar list
// read (session registry and switcher): unanswered grill questions outrank the
// agent-side status (the "?" / "questions" chip), and every non-question status
// maps to its fixed GLYPHS entry — the property the "the two surfaces can never
// disagree" claim rests on. Construct minimal LiveSession fixtures: stateOf
// reads only `status` and `openQuestions`, so the rest is cast-filled.

import { describe, expect, test } from "bun:test";
import type { LiveSession, SessionStatus } from "./api";
import { GLYPHS, stateOf } from "./session-status";

// Only `status` and `openQuestions` are read; the cast keeps the fixture to the
// fields the function actually touches.
function session(status: SessionStatus, openQuestions: number): LiveSession {
  return { status, openQuestions } as LiveSession;
}

describe("stateOf", () => {
  test("returns the questions chip when grill questions are pending", () => {
    // in_review is live, so openQuestions > 0 flips it to the questions chip —
    // NOT the raw `✋` / `awaiting` status glyph.
    expect(stateOf(session("in_review", 2))).toEqual({ glyph: "?", word: "questions" });
  });

  test("ignores pending questions on a terminal session", () => {
    // approved is over: questions can't outrank a finished session, so it keeps
    // its own glyph even with openQuestions set.
    expect(stateOf(session("approved", 3))).toEqual(GLYPHS.approved);
  });

  test("returns the matching GLYPHS entry for a non-question status", () => {
    for (const status of ["draft", "approved", "implementing"] as const) {
      expect(stateOf(session(status, 0))).toEqual(GLYPHS[status]);
    }
  });
});
