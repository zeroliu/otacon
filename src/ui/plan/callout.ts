// Semantic callouts (DESIGN.md §4 visuals, §10 semantic ink): a typed
// blockquote — `> [!risk]` on its own first line — renders as a flat panel
// with a 2px top rule and a glyph+label inked in the type's hue (no fill, no
// radius). The marker line is renderer chrome (consumed, never anchored); the
// body stays markdown both in the source the agent reads and in the DOM, so a
// comment still anchors to a specific callout's text. Unknown or missing
// markers return null and the caller falls back to a plain blockquote, so the
// element always degrades to readable markdown.

import { marked } from "marked";

export const CALLOUT_TYPES = ["risk", "note", "decision", "assumption"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

// Glyph + label per type. The glyph alone carries the hue; the label names the
// type for scanning and screen readers. Filled vs hollow diamond pairs
// decision (committed) with assumption (provisional) on purpose.
const CALLOUT_META: Record<CalloutType, { glyph: string; label: string }> = {
  risk: { glyph: "▲", label: "Risk" },
  note: { glyph: "●", label: "Note" },
  decision: { glyph: "◆", label: "Decision" },
  assumption: { glyph: "◇", label: "Assumption" },
};

// The marker must be the WHOLE first line (`[!type]`), matching how the linter
// detects callouts (src/daemon/linter/parse.ts) — case-insensitive because
// models emit `[!NOTE]` and `[!note]` interchangeably.
const MARKER_RE = /^\s*\[!([a-z]+)\]\s*$/i;

function isCalloutType(type: string): type is CalloutType {
  return (CALLOUT_TYPES as readonly string[]).includes(type);
}

/**
 * Render a blockquote's inner text as a callout panel, or null when its first
 * line is not a known `[!type]` marker. `innerText` is the marked blockquote
 * token's `.text` (the `>`-stripped content); the body after the marker line is
 * re-rendered through marked so nested markdown (and other visuals) still work.
 */
export function calloutHtml(innerText: string): string | null {
  const newline = innerText.indexOf("\n");
  const firstLine = newline === -1 ? innerText : innerText.slice(0, newline);
  const match = MARKER_RE.exec(firstLine);
  if (!match) return null;
  const type = match[1]!.toLowerCase();
  if (!isCalloutType(type)) return null;

  const body = newline === -1 ? "" : innerText.slice(newline + 1);
  const meta = CALLOUT_META[type];
  const rendered = body.trim() === "" ? "" : marked.parse(body, { async: false });
  return (
    `<div class="callout callout-${type}">` +
    `<p class="callout-label">${meta.glyph} ${meta.label}</p>` +
    `<div class="callout-body">${rendered}</div>` +
    `</div>`
  );
}
