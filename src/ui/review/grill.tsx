// Agent question cards (interview questions, review UI): the grill's pinned queue above
// the plan — incoming-transmission cards in the session's accent, designed
// for one thumb while walking. Option chips are full tap targets with the
// recommended option first and starred; a single-choice chip tap IS the
// answer (one tap, no confirm step), multi-choice chips toggle and arm a
// send, optionless questions take free text. An answered entry settles its
// card in place — the flip is the confirmation — but only cards this mount
// watched being open stay settled here; the Interview panel is the archive.

import { memo, useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../api";
import { relativeTime } from "../format";
import { AnswerForm, prefillFromAnswer } from "./answer-form";

// memo'd like the Interview panel and the rail: the review loop re-renders
// per selection tick, while sessionId/transcript only change on SSE frames.
export const GrillQueue = memo(function GrillQueue({
  sessionId,
  transcript,
}: {
  sessionId: string;
  transcript: TranscriptEntry[];
}) {
  // Ids seen unanswered during this mount: when their answer lands over SSE
  // the card settles instead of vanishing. A reload starts clean — history
  // belongs to the Interview panel, not the action queue.
  const watched = useRef(new Set<string>());
  useEffect(() => {
    for (const entry of transcript) {
      if (entry.answer === undefined) watched.current.add(entry.id);
    }
  }, [transcript]);

  const visible = transcript.filter(
    (entry) => entry.answer === undefined || watched.current.has(entry.id),
  );
  if (visible.length === 0) return null;
  const open = visible.filter((entry) => entry.answer === undefined).length;

  return (
    <section className="grill-queue" aria-label="agent questions">
      {/* The codec cursor blinks only while a question is actually open —
          a settled-only queue is history, not a live transmission. */}
      <div className={open > 0 ? "grill-top" : "grill-top grill-top-idle"}>
        <span className="grill-sig" aria-hidden="true">
          ▍
        </span>
        <span>agent on the line</span>
        {open > 0 && <span className="grill-open-count">{open} open</span>}
      </div>
      {visible.map((entry) =>
        entry.answer ? (
          <SettledCard key={entry.id} sessionId={sessionId} entry={entry} />
        ) : (
          <QuestionCard key={entry.id} sessionId={sessionId} entry={entry} />
        ),
      )}
    </section>
  );
});

// A live unanswered question: card chrome + meta, with the interactive body
// supplied by AnswerForm in fresh mode (no prefill/onCancel/onDone), so the
// flow is byte-for-byte the same as before the extraction.
function QuestionCard({
  sessionId,
  entry,
}: {
  sessionId: string;
  entry: TranscriptEntry;
}) {
  const hasOptions = (entry.options?.length ?? 0) > 0;
  return (
    <article className="grill-card" data-q={entry.id}>
      <div className="grill-meta">
        <span className="grill-glyph" aria-hidden="true">
          ▍
        </span>
        <span className="grill-id">{entry.id}</span>
        {entry.multi === true && <span className="grill-mode">pick any</span>}
        {!hasOptions && <span className="grill-mode">free text</span>}
        <span className="grill-when">{relativeTime(entry.askedAt)}</span>
      </div>
      <p className="grill-question">{entry.question}</p>
      <AnswerForm sessionId={sessionId} entry={entry} />
    </article>
  );
}

/**
 * The answered card, settled in place: the one-glance confirmation. While the
 * session is live the answer is not final: an "undo" control reopens the same
 * AnswerForm prefilled with the current answer (single-choice chip lit, note
 * shown), and submitting overwrites it. The `editing` flag lives here and
 * survives the SSE re-render (same entry.id key), so onDone returns to the
 * settled view now showing the new answer the `grill` frame just upserted.
 */
function SettledCard({
  sessionId,
  entry,
}: {
  sessionId: string;
  entry: TranscriptEntry;
}) {
  const [editing, setEditing] = useState(false);
  const answer = entry.answer;
  if (!answer) return null; // callers only route answered entries here
  const picked = answer.choices?.join(", ") ?? answer.choice;
  return (
    <article className="grill-card grill-settled" data-q={entry.id}>
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
          <p className="settled-answer">
            {picked !== undefined && <strong className="settled-choice">{picked}</strong>}
            {picked !== undefined && answer.text !== undefined && " — "}
            {answer.text}
          </p>
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
        </>
      )}
    </article>
  );
}
