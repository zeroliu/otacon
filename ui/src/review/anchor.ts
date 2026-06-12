// Selection anchoring (DESIGN.md §4): a selection inside the plan becomes a
// W3C-annotation-style anchor — the enclosing slug-ID section (plan-view
// renders sections and phases as <section id="decisions">/<section
// id="phase-2">; closest() prefers the innermost, so phase ids win) plus the
// exact text with ±32 chars of context. The reverse direction — click a
// thread, flash its text — re-locates the quote with the prefix as a
// disambiguator and paints it via the CSS Custom Highlight API, which never
// mutates the DOM React owns; when the quote cannot be re-found (it changed
// in a later revision) the section wash alone still lands.

import type { Anchor } from "../api";

/** Context window around the exact quote, per side. */
const CONTEXT = 32;

export interface CapturedSelection {
  anchor: Anchor;
  /** Viewport rect of the selected range, for toolbar/composer placement. */
  rect: { top: number; bottom: number; left: number; width: number };
}

function enclosingSection(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>("section[id]") ?? null;
}

/** The thread/composer target label for an anchor (null = whole plan). */
export function anchorLabel(anchor: Anchor | null): string {
  return anchor ? `#${anchor.section}` : "whole plan";
}

// Renderer chrome whose text exists only in the rendered DOM, never in the
// plan markdown the agent reads: mermaid SVG labels, fence captions, slug
// anchors, phase numbers, Details size badges, the diagram-pending notice.
// An `exact` captured from these could never be re-located — by the agent
// grepping the source, or by findExactRange after a re-render — so the
// toolbar must not offer to anchor there.
const CHROME_SELECTOR = "svg, .fence-head, .anchor-slug, .phase-n, .details-summary, .diagram-pending";

function touchesChrome(range: Range, section: HTMLElement): boolean {
  for (const el of section.querySelectorAll(CHROME_SELECTOR)) {
    if (range.intersectsNode(el)) return true;
  }
  return false;
}

/**
 * The current document selection as an anchor, when it is non-empty and starts
 * inside a slug-ID section of `container`; null otherwise (toolbar hidden).
 */
export function captureSelection(container: HTMLElement): CapturedSelection | null {
  const selection = container.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const exact = range.toString();
  if (exact.trim() === "") return null;
  const section = enclosingSection(range.startContainer);
  if (!section || !container.contains(section)) return null;
  if (touchesChrome(range, section)) return null; // anchor could not survive

  // Context = the text between the section edge and the selection edge,
  // measured through Ranges so it matches what the user actually sees.
  const before = range.cloneRange();
  before.selectNodeContents(section);
  before.setEnd(range.startContainer, range.startOffset);
  const after = range.cloneRange();
  after.selectNodeContents(section);
  if (section.contains(range.endContainer)) {
    after.setStart(range.endContainer, range.endOffset);
  } else {
    after.collapse(false); // selection ran past the section: no suffix
  }

  const anchor: Anchor = { section: section.id, exact };
  const prefix = before.toString().slice(-CONTEXT);
  const suffix = after.toString().slice(0, CONTEXT);
  if (prefix !== "") anchor.prefix = prefix;
  if (suffix !== "") anchor.suffix = suffix;

  const rect = range.getBoundingClientRect();
  return {
    anchor,
    rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
  };
}

/**
 * Re-locate `exact` inside `root` as a Range over its text nodes. The quote
 * was captured from a selection, so within one inline run the concatenated
 * text-node content matches; a quote spanning block boundaries (toString()
 * synthesizes newlines there) just fails to re-locate and the caller falls
 * back to the section wash.
 */
function findExactRange(root: HTMLElement, exact: string, prefix?: string): Range | null {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let full = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
    starts.push(full.length);
    full += node.nodeValue ?? "";
  }
  let index = -1;
  if (prefix !== undefined) {
    const withContext = full.indexOf(prefix + exact);
    if (withContext !== -1) index = withContext + prefix.length;
  }
  if (index === -1) index = full.indexOf(exact);
  if (index === -1) return null;

  const end = index + exact.length;
  const range = doc.createRange();
  let started = false;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Text;
    const nodeStart = starts[i] as number;
    const nodeEnd = nodeStart + (node.nodeValue?.length ?? 0);
    if (!started && index < nodeEnd) {
      range.setStart(node, index - nodeStart);
      started = true;
    }
    if (started && end <= nodeEnd) {
      range.setEnd(node, end - nodeStart);
      return range;
    }
  }
  return null;
}

const FLASH_MS = 1700;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let washed: HTMLElement | undefined;

/**
 * Scroll the anchored section into view and flash the anchored text (plus a
 * soft wash on the section itself). Safe no-op when the section is gone.
 */
export function flashAnchor(container: HTMLElement, anchor: Anchor): void {
  const win = container.ownerDocument.defaultView;
  const section = container.querySelector<HTMLElement>(`#${CSS.escape(anchor.section)}`);
  if (!section || !win) return;
  const reduced = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  section.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });

  if (flashTimer !== undefined) clearTimeout(flashTimer);
  washed?.classList.remove("anchor-hit");
  washed = section;
  void section.offsetWidth; // restart the wash animation on repeat clicks
  section.classList.add("anchor-hit");

  const supportsHighlight = typeof Highlight !== "undefined" && CSS.highlights !== undefined;
  // Always drop the previous flash's highlight first: when this anchor has no
  // re-locatable quote, a still-painted entry from the last click would
  // otherwise linger on the wrong thread's text for the new flash's duration.
  if (supportsHighlight) CSS.highlights.delete("otacon-flash");
  const range = anchor.exact ? findExactRange(section, anchor.exact, anchor.prefix) : null;
  if (range && supportsHighlight) {
    CSS.highlights.set("otacon-flash", new Highlight(range));
  }
  flashTimer = setTimeout(() => {
    section.classList.remove("anchor-hit");
    if (supportsHighlight) CSS.highlights.delete("otacon-flash");
  }, FLASH_MS);
}
