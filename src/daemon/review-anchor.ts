// Anchor quotes are captured in the browser with Range#toString(), so they
// contain the *rendered* report text: inline markdown syntax is gone and
// block boundaries surface as arbitrary whitespace. Matching them against the
// stored report bytes therefore rejects any selection that touches styled
// text. This projection strips the same syntax from both sides and collapses
// whitespace, so containment survives rendering while still refusing quotes
// from a different revision. The check guards revision identity, not
// authenticity — false accepts on adversarial punctuation are harmless.

const FENCE_DELIMITER = /^\s*(?:`{3,}|~{3,}).*$/gm;
const HEADING_MARKER = /^#{1,6}\s+/gm;
const BLOCKQUOTE_MARKER = /^\s*(?:>\s?)+/gm;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/gm;
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
/** Uniformly dropped from both sides so removal can never break containment. */
const INLINE_MARKERS = /[`*]/g;

function projectBlocks(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(FENCE_DELIMITER, "")
    .replace(HEADING_MARKER, "")
    .replace(BLOCKQUOTE_MARKER, "")
    .replace(LIST_MARKER, "")
    .replace(LINK, "$1");
}

function normalizeInline(text: string): string {
  return text.replace(INLINE_MARKERS, "").replace(/\s+/g, " ").trim();
}

/**
 * Whether a rendered-DOM selection quote plausibly belongs to this report
 * revision. Exact byte containment short-circuits; otherwise both sides are
 * projected to rendered text and compared whitespace-insensitively.
 */
export function reportContainsAnchorQuote(report: string, exact: string): boolean {
  if (report.includes(exact)) return true;
  const quote = normalizeInline(exact);
  if (quote === "") return false;
  return normalizeInline(projectBlocks(report)).includes(quote);
}
