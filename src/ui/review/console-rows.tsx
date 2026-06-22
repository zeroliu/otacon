// Shared presentation for the live console + the now-playing bar (the
// live-activity stream, §10a): the per-kind mono glyphs both surfaces use, and
// the <ConsoleRowView> that renders one folded ConsoleRow: its kind glyph, the
// label, a run count ("×5") when collapsed, a tool status mark, an expand
// affordance for `detail`, and (when expanded) the per-member detail bodies.
// Highlights render as emphasized chapter dividers, set apart from the firehose.
// Kept here (not in console-model.ts) so the model stays React-free and unit-
// testable; this file is the thin view layer over it.

import { useState } from "react";
import type { StreamKind } from "../api";
import { relativeTime } from "../format";
import type { ConsoleRow } from "./console-model";

/**
 * One mono glyph per kind, consistent with the codec aesthetic (the `»` activity
 * glyph, the `←` citations): a tool is a chevron-pair, text a speech tick,
 * thinking an ellipsis, a highlight a filled marker (it reads as a chapter mark).
 */
export const KIND_GLYPH: Record<StreamKind, string> = {
  tool: "›",
  text: "·",
  thinking: "…",
  highlight: "◆",
};

/** A tool row's terminal mark: a quiet check, a caution cross, or nothing yet. */
function statusMark(status: ConsoleRow["status"]): string {
  if (status === "ok") return "✓";
  if (status === "error") return "✗";
  return "";
}

export function ConsoleRowView({ row, now }: { row: ConsoleRow; now: number }) {
  const [open, setOpen] = useState(false);
  const count = row.members.length;
  // A detail to reveal exists on any member (the run shares a label but each
  // call has its own body); the affordance shows when at least one carries one.
  const hasDetail = row.members.some((m) => m.detail !== undefined && m.detail !== "");
  const first = row.members[0];
  const when = first ? relativeTime(first.at, now) : "";

  if (row.kind === "highlight") {
    // A progress note: a chapter divider that stands out from the firehose via
    // the accent rule + marker, natural-case body, never collapsed or counted.
    return (
      <li className="lc-row lc-highlight">
        <span className="lc-glyph" aria-hidden="true">
          {KIND_GLYPH.highlight}
        </span>
        <span className="lc-highlight-body">{row.label}</span>
        <span className="lc-when">{when}</span>
      </li>
    );
  }

  return (
    <li className={`lc-row lc-kind-${row.kind}${row.status ? ` lc-status-${row.status}` : ""}`}>
      <button
        type="button"
        className="lc-main"
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
        onClick={() => hasDetail && setOpen((v) => !v)}
      >
        <span className="lc-glyph" aria-hidden="true">
          {KIND_GLYPH[row.kind]}
        </span>
        <span className={row.kind === "thinking" ? "lc-label is-thinking" : "lc-label"}>
          {row.label}
        </span>
        {count > 1 && <span className="lc-count">×{count}</span>}
        {row.status === "running" && (
          <span className="lc-running" aria-label="running">
            ⋯
          </span>
        )}
        {statusMark(row.status) && (
          <span className="lc-mark" aria-hidden="true">
            {statusMark(row.status)}
          </span>
        )}
        <span className="lc-when">{when}</span>
        {hasDetail && (
          <span className="lc-caret" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        )}
      </button>
      {open && hasDetail && (
        <div className="lc-detail">
          {row.members.map((m) =>
            m.detail ? (
              <pre className="lc-detail-body" key={m.seq}>
                {m.detail}
              </pre>
            ) : null,
          )}
        </div>
      )}
    </li>
  );
}
