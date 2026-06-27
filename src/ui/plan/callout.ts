// Semantic callouts (plan structure, lint, and anchoring visuals, review UI semantic ink): a typed
// marker — `[!risk]`, `[!note]`, `[!decision]`, or `[!assumption]` — anywhere in
// prose renders as a small inline badge inked in the type's hue (a mono
// uppercase pill, label only). The badge span is renderer chrome
// (`user-select: none`, never anchored); the surrounding prose stays markdown
// both in the source the agent reads and in the DOM, so a comment still anchors
// to the line's text. Detected as a marked inline token, exactly like the scope
// pills (marked-setup.ts); the `!` keeps the closed type set from colliding
// with ordinary brackets. Unknown markers are left as literal text.

export const CALLOUT_TYPES = ["risk", "note", "decision", "assumption"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

// Label per type. The badge is label-only — the hue (styles.css) carries the
// type; the label names it for scanning and screen readers.
const LABEL: Record<CalloutType, string> = {
  risk: "Risk",
  note: "Note",
  decision: "Decision",
  assumption: "Assumption",
};

// The inline marker: `[!type]` for the closed set, anchored at the start of the
// inline src the tokenizer is handed (the `start` hook positions it). Case-
// insensitive because models emit `[!NOTE]` and `[!note]` interchangeably.
export const BADGE_RE = /^\[!(risk|note|decision|assumption)\]/i;

/** Render a known callout type as its inline badge span. */
export function badgeHtml(kind: CalloutType): string {
  return `<span class="callout-badge callout-badge-${kind}">${LABEL[kind]}</span>`;
}
