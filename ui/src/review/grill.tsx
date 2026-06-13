// Agent question cards (DESIGN.md §8, §10): the grill's pinned queue above
// the plan — incoming-transmission cards in the session's accent, designed
// for one thumb while walking. Option chips are full tap targets with the
// recommended option first and starred; a single-choice chip tap IS the
// answer (one tap, no confirm step), multi-choice chips toggle and arm a
// send, optionless questions take free text. An answered entry settles its
// card in place — the flip is the confirmation — but only cards this mount
// watched being open stay settled here; the Interview panel is the archive.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { AnswerDraft, TranscriptEntry } from "../api";
import { postAnswer } from "../api";
import { relativeTime } from "../format";

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
          <SettledCard key={entry.id} entry={entry} />
        ) : (
          <QuestionCard key={entry.id} sessionId={sessionId} entry={entry} />
        ),
      )}
    </section>
  );
});

/** The agent's options with the recommended one first (DESIGN.md §8). */
function orderedOptions(entry: TranscriptEntry): string[] {
  if (!entry.options) return [];
  const { recommend } = entry;
  if (recommend === undefined) return entry.options;
  return [recommend, ...entry.options.filter((option) => option !== recommend)];
}

function QuestionCard({
  sessionId,
  entry,
}: {
  sessionId: string;
  entry: TranscriptEntry;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const options = useMemo(() => orderedOptions(entry), [entry]);
  const hasOptions = options.length > 0;
  const note = text.trim() === "" ? undefined : text;

  const send = (draft: AnswerDraft) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    void postAnswer(sessionId, draft).then((ok) => {
      // On success the grill SSE frame settles this card; only failure needs UI.
      setBusy(false);
      if (!ok) setFailed(true);
    });
  };

  const tapSingle = (choice: string) => send({ question: entry.id, choice, text: note });
  const toggleMulti = (option: string) =>
    setPicked((prev) =>
      prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option],
    );

  // The explicit send button (DESIGN.md §8): free text and multi-select always
  // carry one; single-select grows one only while a custom answer is open — the
  // "+ add a note" box doubles as the chip-less custom-answer field, so typed
  // text alone is a valid answer ("Other" parity), or it rides a chip tap.
  // Built only when shown (null otherwise), so the gate and the object it feeds
  // stay one expression rather than computing a discarded foot every render.
  const showFoot = entry.multi === true || !hasOptions || noteOpen;
  const foot = !showFoot
    ? null
    : entry.multi === true
      ? {
          label: "send answer",
          disabled: picked.length === 0 && note === undefined,
          draft:
            picked.length > 0
              ? { question: entry.id, choices: picked, text: note }
              : { question: entry.id, text: note },
        }
      : {
          // free text, or single-select's custom answer
          label: hasOptions ? "send custom" : "send answer",
          disabled: note === undefined,
          draft: { question: entry.id, text: note },
        };

  return (
    <article className="grill-card" data-q={entry.id} aria-busy={busy}>
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

      {hasOptions ? (
        <div className="grill-chips" role={entry.multi === true ? "group" : undefined}>
          {options.map((option) => {
            const rec = option === entry.recommend;
            const className = [
              "grill-chip",
              rec ? "grill-chip-rec" : "",
              picked.includes(option) ? "grill-chip-on" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={option}
                type="button"
                className={className}
                disabled={busy}
                aria-pressed={entry.multi === true ? picked.includes(option) : undefined}
                onClick={() =>
                  entry.multi === true ? toggleMulti(option) : tapSingle(option)
                }
              >
                {rec && (
                  <span className="grill-rec" aria-hidden="true">
                    ★
                  </span>
                )}
                <span className="grill-chip-label">{option}</span>
                {rec && <span className="grill-rec-word">rec</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <textarea
          className="grill-text"
          aria-label={`answer to ${entry.id}`}
          placeholder="type your answer…"
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
      )}

      {hasOptions &&
        (noteOpen ? (
          <textarea
            className="grill-text grill-note"
            aria-label={`note for ${entry.id}`}
            placeholder="optional note for the agent…"
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            // eslint-disable-next-line jsx-a11y/no-autofocus — opened on demand
            autoFocus
          />
        ) : (
          <button
            type="button"
            className="grill-note-toggle"
            disabled={busy}
            onClick={() => setNoteOpen(true)}
          >
            + add a note
          </button>
        ))}

      {foot && (
        <div className="grill-foot">
          <button
            type="button"
            className="btn btn-primary grill-send"
            disabled={busy || foot.disabled}
            onClick={() => send(foot.draft)}
          >
            {busy ? "sending…" : foot.label}
          </button>
        </div>
      )}
      {failed && (
        <p className="composer-hint composer-failed grill-failed">
          couldn't send — is otacond up?
        </p>
      )}
    </article>
  );
}

/** The answered card, settled in place: the one-glance confirmation. */
function SettledCard({ entry }: { entry: TranscriptEntry }) {
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
      <p className="settled-answer">
        {picked !== undefined && <strong className="settled-choice">{picked}</strong>}
        {picked !== undefined && answer.text !== undefined && " — "}
        {answer.text}
      </p>
    </article>
  );
}
