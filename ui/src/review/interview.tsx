// The collapsible Interview panel (DESIGN.md §8, §10): the grill transcript
// as reviewable telemetry — every Q&A with its asked/answered state and
// timestamps. Decisions in the rendered plan citing `← q<n>` deep-link here:
// the panel opens, scrolls to the entry, and flashes it, answering "why?"
// with what the user actually said at the time.

import { memo, useEffect, useRef } from "react";
import type { TranscriptEntry } from "../api";
import { relativeTime } from "../format";

/** A deep-link request; `nonce` re-fires the flash on repeat clicks. */
export interface InterviewTarget {
  id: string;
  nonce: number;
}

const FLASH_MS = 1700;

// memo'd like the rail: the review loop re-renders per selection tick, while
// transcript/open/target only change on SSE frames or explicit interaction.
export const InterviewPanel = memo(function InterviewPanel({
  transcript,
  open,
  onToggle,
  target,
}: {
  transcript: TranscriptEntry[];
  open: boolean;
  onToggle: () => void;
  target: InterviewTarget | null;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Deep-link landing: the parent opens the panel and sets the target in one
  // commit, so by the time this effect runs the entry is in the DOM.
  useEffect(() => {
    if (!target || !open) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-iv="${target.id}"]`);
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    el.classList.remove("iv-hit");
    void el.offsetWidth; // restart the wash on repeat clicks
    el.classList.add("iv-hit");
    const timer = setTimeout(() => el.classList.remove("iv-hit"), FLASH_MS);
    return () => clearTimeout(timer);
  }, [target, open]);

  if (transcript.length === 0) return null;
  const answered = transcript.filter((entry) => entry.answer !== undefined).length;

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
          {answered}/{transcript.length} answered
        </span>
        <span className="interview-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="interview-body" ref={bodyRef}>
          {transcript.map((entry) => (
            <InterviewEntry key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
});

function InterviewEntry({ entry }: { entry: TranscriptEntry }) {
  const answer = entry.answer;
  const chosen = new Set(answer?.choices ?? (answer?.choice !== undefined ? [answer.choice] : []));
  const echo = [answer?.choices?.join(", ") ?? answer?.choice, answer?.text]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" — ");
  return (
    <article className="iv-entry" data-iv={entry.id}>
      <div className="iv-meta">
        <span className="iv-id">{entry.id}</span>
        {entry.multi === true && <span className="iv-mode">multi</span>}
        <span className="iv-when">asked {relativeTime(entry.askedAt)}</span>
      </div>
      <p className="iv-q">{entry.question}</p>
      {entry.options && (
        <div className="iv-options" aria-label="options offered">
          {entry.options.map((option) => (
            <span
              key={option}
              className={chosen.has(option) ? "iv-opt iv-opt-chosen" : "iv-opt"}
            >
              {option === entry.recommend && (
                <span className="grill-rec" aria-hidden="true">
                  ★
                </span>
              )}
              {option}
            </span>
          ))}
        </div>
      )}
      {answer ? (
        <div className="iv-answer">
          <span className="iv-answer-label">↳ you · {relativeTime(answer.answeredAt)}</span>
          {echo !== "" && <p className="iv-answer-body">{echo}</p>}
        </div>
      ) : (
        <p className="iv-awaiting">awaiting your answer</p>
      )}
    </article>
  );
}
