// The collapsible Interview panel (interview questions, review UI): the single
// grill surface. Two labeled zones, newest first within each: an "open" zone on
// top where unanswered questions are answered INLINE (the same interactive card
// the old pinned queue used), a divider, then an "answered" zone below where
// each card shows only the answer plus an `undo` that reveals the option chips
// to change it. Decisions in the rendered plan citing `← q<n>` deep-link here:
// the panel opens, scrolls to the entry, and flashes it, answering "why?" with
// what the user actually said at the time.

import { memo, useEffect, useRef, useState } from "react";
import type { GrillAnswer, TranscriptEntry } from "../api";
import { relativeTime } from "../format";
import { AnswerForm, prefillFromAnswer } from "./answer-form";
import { motionSafeScroll } from "./anchor";

/** A deep-link request; `nonce` re-fires the flash on repeat clicks. */
export interface InterviewTarget {
  id: string;
  nonce: number;
}

const FLASH_MS = 1700;

// memo'd like the rail: the review loop re-renders per selection tick, while
// transcript/open/target only change on SSE frames or explicit interaction.
export const InterviewPanel = memo(function InterviewPanel({
  sessionId,
  transcript,
  open,
  onToggle,
  target,
  editable,
}: {
  sessionId: string;
  transcript: TranscriptEntry[];
  open: boolean;
  onToggle: () => void;
  target: InterviewTarget | null;
  // While the session is live an open question is answered inline and an
  // answered entry can be reopened and changed here; once read-only the archive
  // shows the static answer echo with no form and no undo.
  editable: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Deep-link landing: the parent opens the panel and sets the target in one
  // commit, so by the time this effect runs the entry is in the DOM.
  useEffect(() => {
    if (!target || !open) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-iv="${target.id}"]`);
    if (!el) return;
    motionSafeScroll(el, "center");
    el.classList.remove("iv-hit");
    void el.offsetWidth; // restart the wash on repeat clicks
    el.classList.add("iv-hit");
    const timer = setTimeout(() => el.classList.remove("iv-hit"), FLASH_MS);
    return () => clearTimeout(timer);
  }, [target, open]);

  if (transcript.length === 0) return null;

  // Two zones, each newest first: the active/most-recent question leads. Reverse
  // copies of the filtered arrays so the prop is never mutated. `open` is ordered
  // by askedAt descending, `answered` by answeredAt descending.
  const open$ = transcript.filter((entry) => entry.answer === undefined).reverse();
  const answered$ = transcript
    .filter((entry) => entry.answer !== undefined)
    .sort((a, b) => b.answer!.answeredAt.localeCompare(a.answer!.answeredAt));
  const answeredCount = answered$.length;

  return (
    <section className="interview" id="interview" aria-label="interview transcript">
      <button
        type="button"
        className="interview-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="interview-glyph" aria-hidden="true">
          ⊙
        </span>
        <span className="interview-word">interview</span>
        <span className="interview-tally">
          {answeredCount}/{transcript.length} answered
        </span>
        <span className="interview-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="interview-body" ref={bodyRef}>
          {open$.length > 0 && (
            <div className="iv-zone iv-zone-open">
              <p className="iv-zone-label">open</p>
              {open$.map((entry) => (
                <OpenCard
                  key={entry.id}
                  sessionId={sessionId}
                  entry={entry}
                  editable={editable}
                />
              ))}
            </div>
          )}
          {open$.length > 0 && answered$.length > 0 && (
            <hr className="iv-divider" aria-hidden="true" />
          )}
          {answered$.length > 0 && (
            <div className="iv-zone iv-zone-answered">
              <p className="iv-zone-label">answered</p>
              {answered$.map((entry) => (
                <AnsweredCard
                  key={entry.id}
                  sessionId={sessionId}
                  entry={entry}
                  editable={editable}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
});

// An open question: card chrome + meta, with the interactive body supplied by
// AnswerForm in fresh mode (no prefill), so answering happens inline exactly as
// the old pinned queue did. A read-only archive can hold an open question (the
// session ended before it was answered): it shows the static awaiting line, no
// form. `data-iv` keeps the deep-link flash/scroll working.
function OpenCard({
  sessionId,
  entry,
  editable,
}: {
  sessionId: string;
  entry: TranscriptEntry;
  editable: boolean;
}) {
  const hasOptions = (entry.options?.length ?? 0) > 0;
  return (
    <article className="grill-card" data-iv={entry.id}>
      <div className="grill-meta">
        <span className="grill-glyph" aria-hidden="true">
          ▍
        </span>
        <span className="grill-id">{entry.id}</span>
        {entry.multi === true && <span className="grill-mode">pick any</span>}
        {!hasOptions && <span className="grill-mode">free text</span>}
        <span className="grill-when">asked {relativeTime(entry.askedAt)}</span>
      </div>
      <p className="grill-question">{entry.question}</p>
      {editable ? (
        <AnswerForm sessionId={sessionId} entry={entry} />
      ) : (
        <p className="iv-awaiting">awaiting your answer</p>
      )}
    </article>
  );
}

/**
 * An answered question, settled in place: the one-glance confirmation showing
 * ONLY the answer (no full option list). While editable an "undo" control
 * reopens the same AnswerForm prefilled with the current answer (its option
 * chips reappear), so the answer can be changed; submitting overwrites it. The
 * `editing` flag lives here and survives the SSE re-render (same entry.id key),
 * so onDone returns to the settled view now showing the new answer the `grill`
 * frame just upserted. A read-only archive shows the echo with no undo.
 */
function AnsweredCard({
  sessionId,
  entry,
  editable,
}: {
  sessionId: string;
  entry: TranscriptEntry;
  editable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const answer = entry.answer;
  if (!answer) return null; // callers only route answered entries here
  return (
    <article className="grill-card grill-settled" data-iv={entry.id}>
      <div className="grill-meta">
        <span className="settled-check" aria-hidden="true">
          ✓
        </span>
        <span className="grill-id">{entry.id}</span>
        <span className="settled-word">answered</span>
        <span className="grill-when">{relativeTime(answer.answeredAt)}</span>
      </div>
      <p className="grill-question grill-question-settled">{entry.question}</p>
      {editing ? (
        <AnswerForm
          sessionId={sessionId}
          entry={entry}
          prefill={prefillFromAnswer(answer)}
          onCancel={() => setEditing(false)}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          <p className="settled-answer">{answerEcho(answer)}</p>
          {editable && (
            <button
              type="button"
              className="grill-undo"
              onClick={() => setEditing(true)}
            >
              <span className="grill-undo-glyph" aria-hidden="true">
                ↶
              </span>
              undo
            </button>
          )}
        </>
      )}
    </article>
  );
}

/** The answer echo: chosen choice(s) and/or free text, no option list. */
function answerEcho(answer: GrillAnswer) {
  const picked = answer.choices?.join(", ") ?? answer.choice;
  return (
    <>
      {picked !== undefined && <strong className="settled-choice">{picked}</strong>}
      {picked !== undefined && answer.text !== undefined && " — "}
      {answer.text}
    </>
  );
}
