// The inline diff (threaded review and revision layer 3, review UI): the same 720px reading column
// as the clean dossier, re-read as change telemetry. Each slug unit keeps its
// section rail and gains a status tag; changed units render their server
// hunks as instrument lines (op gutter + tinted wash, mono because the lines
// are plan *source*), unchanged units collapse to a calm rail — the diff
// toggle exists to audit change, and the clean view is one keystroke away
// (DECISIONS.md "Diff mode: unchanged units collapse to calm rails").
// Units carry their real slug ids, so j/k jumps and thread clicks land in
// either view — only one view is ever mounted.

import { Fragment, memo } from "react";
import type { DiffHunk, DiffPayload, SectionDiff } from "../api";

function Hunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="hunk">
      {hunk.lines.map((line, i) => (
        <div key={i} className={`dline dline-${line.op}`}>
          <span className="dline-op" aria-hidden="true">
            {line.op === "add" ? "+" : line.op === "del" ? "−" : ""}
          </span>
          <span className="dline-text">{line.text === "" ? "\u00a0" : line.text}</span>
        </div>
      ))}
    </div>
  );
}

function DiffSection({ section }: { section: SectionDiff }) {
  const calm = section.status === "unchanged";
  return (
    <section id={section.id} className={`diff-unit diff-${section.status}`}>
      <header className="section-rail">
        <h2 className="section-title">{section.title}</h2>
        <span className="rail-line" aria-hidden="true" />
        <span className={`diff-status diff-status-${section.status}`}>{section.status}</span>
      </header>
      {!calm && section.hunks.length > 0 && (
        <div className="diff-body">
          {section.hunks.map((hunk, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <div className="hunk-gap" aria-hidden="true">
                  · · ·
                </div>
              )}
              <Hunk hunk={hunk} />
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}

// memo'd for the same reason as PlanView: the review loop re-renders per
// selection tick and drawer keystroke; the diff payload only gets a new
// identity when an endpoint of the comparison actually moves.
export const DiffView = memo(function DiffView({ diff }: { diff: DiffPayload }) {
  const touched = diff.sections.filter((s) => s.status !== "unchanged").length;
  return (
    <article className="plan plan-diff" aria-label={`diff r${diff.from} to r${diff.to}`}>
      <p className="diff-legend">
        {diff.from === 0 ? "r0 · empty plan" : `r${diff.from}`} → r{diff.to}
        <span className="diff-legend-tally">
          {touched === 0 ? " · no changes" : ` · ${touched} ${touched === 1 ? "section" : "sections"} touched`}
        </span>
      </p>
      {diff.sections.map((section) => (
        <DiffSection key={section.id} section={section} />
      ))}
    </article>
  );
});
