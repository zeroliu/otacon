// The status glyph/word derivation, single-sourced for every condensed status
// surface (the switcher's chips and dropdown, the sidebar list rows): one map,
// so a session's glyph can never disagree between the strip you switch through
// and the list you scan. Mirrors the questionsPending rule the chips already
// follow (chip.tsx) — derive once, render on every face.

import type { LiveSession, SessionStatus } from "./api";
import { questionsPending } from "./chip";

export const GLYPHS: Record<SessionStatus, { glyph: string; word: string }> = {
  draft: { glyph: "✎", word: "drafting" },
  in_review: { glyph: "✋", word: "awaiting" },
  revising: { glyph: "⏳", word: "revising" },
  // comment & approve (approval and archive lifecycle): the agent is folding open comments in before commit.
  finalizing: { glyph: "⏳", word: "finalizing" },
  approved: { glyph: "✓", word: "approved" },
  // The implement lifecycle (approval and archive lifecycle): a spinner-ish gear while the agent
  // builds, the approved check once it lands, a cross when the build aborted.
  implementing: { glyph: "⚙", word: "implementing" },
  implemented: { glyph: "✔", word: "implemented" },
  implement_failed: { glyph: "✕", word: "failed" },
};

export function stateOf(session: LiveSession): { glyph: string; word: string } {
  // questionsPending is the status chips' derivation — one source, so the
  // index card and the switcher can never disagree about a session's state.
  if (questionsPending(session.status, session.openQuestions)) {
    return { glyph: "?", word: "questions" };
  }
  return GLYPHS[session.status];
}
