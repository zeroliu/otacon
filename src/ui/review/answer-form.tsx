// The interactive answer body of a grill question card (interview questions),
// extracted so it can be reused: the live queue's fresh QuestionCard, a settled
// card reopened to change an answer, and (later) the Interview panel all wrap
// the same chips/textarea/note/foot region. Option chips are full tap targets
// with the recommended option first and starred; a single-choice chip tap IS
// the answer (one tap, no confirm step), multi-choice chips toggle and arm a
// send, optionless questions take free text. Submitting calls the existing
// postAnswer; a re-answer overwrites server-side and the `grill` SSE frame
// re-settles the card.

import { useMemo, useState } from "react";
import type { AnswerDraft, GrillAnswer, TranscriptEntry } from "../api";
import { postAnswer } from "../api";

/** The seed for an AnswerForm: which chips are pre-picked and the note text. */
export interface AnswerPrefill {
  picked: string[];
  text: string;
}

/** The agent's options with the recommended one first (interview questions). */
export function orderedOptions(entry: TranscriptEntry): string[] {
  if (!entry.options) return [];
  const { recommend } = entry;
  if (recommend === undefined) return entry.options;
  return [recommend, ...entry.options.filter((option) => option !== recommend)];
}

/**
 * Seed an edit-mode form from the answer already on a settled card, so reopening
 * it shows the current answer pre-selected (single-choice chip lit, note shown).
 * `picked` mirrors the answer's chip(s); `text` is the note (or whole free-text
 * answer). Empty defaults when neither is present.
 */
export function prefillFromAnswer(answer: GrillAnswer): AnswerPrefill {
  return {
    picked: answer.choices ?? (answer.choice ? [answer.choice] : []),
    text: answer.text ?? "",
  };
}

/**
 * The chips/textarea/note/foot region of a grill answer, with no card chrome
 * (the caller supplies the `<article>` and meta). Fresh mode (no `onCancel`/`onDone`):
 * a successful send relies on the `grill` SSE frame to settle the card, byte-for-byte
 * the old QuestionCard behavior. Edit mode (`onCancel` provided, from a reopened
 * settled card): the foot always renders with a Cancel beside send, the form seeds
 * from `prefill`, and a successful send calls `onDone` so the card returns to its
 * settled view (now showing the new answer the SSE frame just upserted).
 */
export function AnswerForm({
  sessionId,
  entry,
  prefill,
  onCancel,
  onDone,
}: {
  sessionId: string;
  entry: TranscriptEntry;
  prefill?: AnswerPrefill;
  onCancel?: () => void;
  onDone?: () => void;
}) {
  const seed = prefill ?? { picked: [], text: "" };
  const editing = onCancel !== undefined;
  const [picked, setPicked] = useState<string[]>(seed.picked);
  const [text, setText] = useState(seed.text);
  const options = useMemo(() => orderedOptions(entry), [entry]);
  const hasOptions = options.length > 0;
  // An existing note (reopened with text already there) shows expanded, so the
  // user sees what they wrote; a fresh option question starts with it collapsed.
  const [noteOpen, setNoteOpen] = useState(hasOptions && seed.text.trim() !== "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const note = text.trim() === "" ? undefined : text;

  const send = (draft: AnswerDraft) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    void postAnswer(sessionId, draft).then((ok) => {
      setBusy(false);
      if (!ok) {
        setFailed(true);
        return;
      }
      // Edit mode closes back to the settled view (the SSE frame supplies the
      // new answer); fresh mode relies on that same frame to settle in place.
      onDone?.();
    });
  };

  const tapSingle = (choice: string) => send({ question: entry.id, choice, text: note });
  const toggleMulti = (option: string) =>
    setPicked((prev) =>
      prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option],
    );

  // The explicit send button (interview questions): free text and multi-select always
  // carry one; single-select grows one only while a custom answer is open (the
  // "+ add a note" box doubles as the chip-less custom-answer field), so typed
  // text alone is a valid answer ("Other" parity), or it rides a chip tap.
  // Built only when shown (null otherwise), so the gate and the object it feeds
  // stay one expression rather than computing a discarded foot every render.
  const sendBtn = !(entry.multi === true || !hasOptions || noteOpen)
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

  // Edit mode keeps a foot even for a bare single-choice change (its lone Cancel
  // lives there), so a reopened card can always back out without changing.
  const showFoot = sendBtn !== null || editing;

  // `display:contents` keeps the busy region's box out of layout (the chips,
  // textarea, note, and foot stay direct flow children of the card, byte-for-byte
  // the old DOM) while restoring the `aria-busy` signal the article carried before
  // the extraction — now co-located with the state that drives it.
  return (
    <div style={{ display: "contents" }} aria-busy={busy}>
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

      {showFoot && (
        <div className="grill-foot">
          {editing && (
            <button
              type="button"
              className="btn grill-cancel"
              disabled={busy}
              onClick={onCancel}
            >
              cancel
            </button>
          )}
          {sendBtn && (
            <button
              type="button"
              className="btn btn-primary grill-send"
              disabled={busy || sendBtn.disabled}
              onClick={() => send(sendBtn.draft)}
            >
              {busy ? "sending…" : sendBtn.label}
            </button>
          )}
        </div>
      )}
      {failed && (
        <p className="composer-hint composer-failed grill-failed">
          couldn't send — is otacond up?
        </p>
      )}
    </div>
  );
}
