// Open/collapse logic for the review UI's Interview panel, pulled out as pure
// functions plus a thin React hook, the same split as session-sheet-state.ts
// (shouldCloseSheet) and compact.ts (nextCompact). The panel auto-opens at two
// moments the user did not click for: during the grill phase (the answering is
// the point of the screen) and the instant a brand-new unanswered question
// appears (a fresh ask must surface itself, even mid-review). The pure
// functions hold every one of those decisions so they unit-test without a
// render; the hook is glue. This matters because the repo renders UI with
// renderToStaticMarkup, which SKIPS effects, so any effect-driven behavior that
// lives only inside a useEffect would never be exercised by a test.

import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../api";

// Whether any transcript entry is still awaiting an answer.
export function hasOpenQuestion(transcript: TranscriptEntry[]): boolean {
  return transcript.some((entry) => entry.answer === undefined);
}

// The panel's open state at mount: open during the grill phase (status draft) or
// whenever a question is already pending (a reload mid-question must show it),
// collapsed otherwise.
export function initialInterviewOpen(
  grillPhase: boolean,
  transcript: TranscriptEntry[],
): boolean {
  return grillPhase || hasOpenQuestion(transcript);
}

// The ids present-and-unanswered in `transcript` but absent from `seen`: brand-new
// asks that should pop the panel open. An answer or re-answer reuses a known id, so
// it is never "fresh" and never reopens the panel. Pure: does not mutate `seen`.
export function freshOpenQuestionIds(
  seen: ReadonlySet<string>,
  transcript: TranscriptEntry[],
): string[] {
  return transcript
    .filter((entry) => entry.answer === undefined && !seen.has(entry.id))
    .map((entry) => entry.id);
}

// The Interview panel's open flag + setter + toggle: a drop-in for the inline
// useState the ReviewLoop used to carry. Seeds from initialInterviewOpen (lazy).
// Two effects: on grillPhase change, re-run initialInterviewOpen so the panel
// re-opens/collapses with the phase but stays open if a question is still pending
// when grill ends; on transcript change, record every id as seen and FORCE
// setOpen(true) when a genuinely new unanswered id appeared. Mount is a no-op
// because `seen` is pre-seeded; setOpen(true) while already open is a React no-op,
// so a spurious re-run never reopens a panel the user deliberately collapsed.
export function useInterviewOpen(
  grillPhase: boolean,
  transcript: TranscriptEntry[],
): readonly [boolean, (open: boolean) => void, () => void] {
  const [open, setOpen] = useState(() => initialInterviewOpen(grillPhase, transcript));
  const lastGrill = useRef(grillPhase);
  const seen = useRef<Set<string>>(new Set(transcript.map((entry) => entry.id)));

  useEffect(() => {
    if (grillPhase === lastGrill.current) return;
    lastGrill.current = grillPhase;
    setOpen(initialInterviewOpen(grillPhase, transcript));
  }, [grillPhase, transcript]);

  useEffect(() => {
    const fresh = freshOpenQuestionIds(seen.current, transcript);
    for (const entry of transcript) seen.current.add(entry.id);
    if (fresh.length > 0) setOpen(true);
  }, [transcript]);

  const toggle = useCallback(() => setOpen((value) => !value), []);
  return [open, setOpen, toggle];
}
