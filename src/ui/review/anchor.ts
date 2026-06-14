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
const CHROME_SELECTOR =
  "svg, .fence-head, .anchor-slug, .phase-n, .details-summary, .diagram-pending, .sec-menu";

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

/** The exact-quote lookup inside an already-found section — the primitive the
 * flash and the persistent thread marks share. Truthy guard (not `!== undefined`):
 * an empty quote can't anchor, and would otherwise `indexOf("")`-match at the
 * section's start and light its opening text. */
function rangeInSection(section: HTMLElement, anchor: Anchor): Range | null {
  return anchor.exact ? findExactRange(section, anchor.exact, anchor.prefix) : null;
}

/**
 * Re-locate an anchor's quote as a Range inside its slug-ID section of
 * `container`. Null when the section is gone, the anchor carries no quote
 * (whole-plan), or the quote no longer re-locates (a later revision changed
 * it) — every caller falls back to leaving that anchor unlit.
 */
export function locateAnchor(container: HTMLElement, anchor: Anchor): Range | null {
  const section = container.querySelector<HTMLElement>(`#${CSS.escape(anchor.section)}`);
  return section ? rangeInSection(section, anchor) : null;
}

const FLASH_MS = 1700;
// The flash sits above the persistent thread marks, so a clicked thread still
// pops over its own steady ink (DESIGN.md §10; persistent layers keep the
// default priority 0).
const FLASH_PRIORITY = 1;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let washed: HTMLElement | undefined;

/**
 * scrollIntoView that honors prefers-reduced-motion (smooth → auto) — the one
 * scroll affordance every jump shares (anchor flashes, decision deep-links,
 * the sticky bar's ❓), so no jump can forget the preference.
 */
export function motionSafeScroll(el: Element, block: ScrollLogicalPosition): void {
  const win = el.ownerDocument.defaultView ?? window;
  const reduced = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block });
}

/**
 * Scroll the anchored section into view and flash the anchored text (plus a
 * soft wash on the section itself). Safe no-op when the section is gone.
 */
export function flashAnchor(container: HTMLElement, anchor: Anchor): void {
  const win = container.ownerDocument.defaultView;
  const section = container.querySelector<HTMLElement>(`#${CSS.escape(anchor.section)}`);
  if (!section || !win) return;
  motionSafeScroll(section, "center");

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
  const range = rangeInSection(section, anchor);
  if (range && supportsHighlight) {
    const flash = new Highlight(range);
    flash.priority = FLASH_PRIORITY;
    CSS.highlights.set("otacon-flash", flash);
  }
  flashTimer = setTimeout(() => {
    section.classList.remove("anchor-hit");
    if (supportsHighlight) CSS.highlights.delete("otacon-flash");
  }, FLASH_MS);
}

/** The two persistent thread inks (DESIGN.md §10), keyed by thread kind. */
export type HighlightKind = "question" | "comment";

/** One open thread (or unsent draft) to keep lit on its anchored plan text. */
export interface LitThread {
  /** Rail thread id (t<n>/q<n>), or `draft:<key>` for an unsent comment. */
  id: string;
  anchor: Anchor;
  kind: HighlightKind;
}

const HIGHLIGHT_NAME: Record<HighlightKind, string> = {
  question: "otacon-q",
  comment: "otacon-comment",
};

/**
 * Paint the persistent thread marks: re-locate each lit thread's quote and
 * register one named CSS highlight per kind (open questions vs open
 * comments + unsent drafts), deleting a kind whose set is empty so a resolved
 * or answered thread clears on the next paint. A no-op without the Custom
 * Highlight API — the same graceful degradation the flash relies on — and
 * silently skips any quote that no longer re-locates. Whole-plan and orphaned
 * anchors never reach here (the caller filters them). Paints by registering
 * Ranges, never by re-rendering the plan, so an in-progress selection survives
 * (DECISIONS.md: a re-render rewrites the DOM and kills selections).
 */
export function paintThreads(container: HTMLElement, lit: LitThread[]): void {
  if (typeof Highlight === "undefined" || CSS.highlights === undefined) return;
  const ranges: Record<HighlightKind, Range[]> = { question: [], comment: [] };
  for (const entry of lit) {
    const range = locateAnchor(container, entry.anchor);
    if (range) ranges[entry.kind].push(range);
  }
  for (const kind of Object.keys(ranges) as HighlightKind[]) {
    const set = ranges[kind];
    if (set.length === 0) CSS.highlights.delete(HIGHLIGHT_NAME[kind]);
    else CSS.highlights.set(HIGHLIGHT_NAME[kind], new Highlight(...set));
  }
}

/** Drop both persistent thread inks (the diff view, or leaving the review). */
export function clearThreadHighlights(): void {
  if (typeof CSS === "undefined" || CSS.highlights === undefined) return;
  CSS.highlights.delete(HIGHLIGHT_NAME.question);
  CSS.highlights.delete(HIGHLIGHT_NAME.comment);
}

/**
 * The caret (node + offset) under a viewport point. Prefers the standard
 * `caretPositionFromPoint`, falling back to WebKit's `caretRangeFromPoint`
 * (still the only one Safari ships) — both optional-called so a browser
 * missing one degrades instead of throwing.
 */
function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/**
 * The lit thread whose anchored text sits under a viewport point, or null —
 * the reverse of the flash: a tap on a painted span focuses its rail thread.
 * The Custom Highlight API never intercepts pointer events, so the click falls
 * through to the underlying text node and we hit-test the lit set here.
 * Re-locates ranges at call time (never caches live Ranges) so it survives a
 * revision re-render; the innermost (shortest) quote wins when marks overlap.
 */
export function threadAtPoint(
  container: HTMLElement,
  lit: LitThread[],
  x: number,
  y: number,
): string | null {
  const caret = caretAt(container.ownerDocument, x, y);
  if (!caret) return null;
  let best: { id: string; length: number } | null = null;
  for (const entry of lit) {
    const range = locateAnchor(container, entry.anchor);
    if (!range || !range.isPointInRange(caret.node, caret.offset)) continue;
    const length = entry.anchor.exact?.length ?? 0;
    if (!best || length < best.length) best = { id: entry.id, length };
  }
  return best?.id ?? null;
}
