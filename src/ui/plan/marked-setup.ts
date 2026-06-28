// The single source of `marked` configuration for plan rendering: GFM plus the
// markdown-native review visuals (plan structure, lint, and anchoring). Kept free of React and
// DOMPurify so the whole transform pipeline is unit-testable without a DOM
// (markdown.test.ts) and typechecks under the no-JSX test config. markdown.tsx
// imports the configured `marked` from here, then parses + sanitizes.

import { marked } from "marked";
import { BADGE_RE, badgeHtml, type CalloutType } from "./callout.js";

// A decision-matrix row is "chosen" when its first body cell is the ✓ marker.
// We test the already-rendered cells — header cells render as `<th>`, so the
// header row never matches, and any other table just degrades to a plain table
// (plan structure, lint, and anchoring, review UI).
const CHOSEN_CELL_RE = /^\s*<td[^>]*>\s*✓/;

// Inline scope pills: a closed set of bracket tokens (plan structure, lint, and anchoring). The
// negative lookahead leaves markdown links (`[new](url)`) and reference links
// (`[new][ref]`) to marked's own tokenizers — our inline extension is tried
// first, so without it `[new](url)` would render as a pill and swallow the
// link. `[assumed]` is deliberately not in the set: it is the decision-trace
// tag, converted to its own span before parse (plan-view.tsx), never a pill.
// The pill renders its keyword without the brackets, so — like inline emphasis
// — a comment whose quote spans a pill may not survive a cross-revision
// re-anchor; its anchor is marked internally and the thread stays inline & muted
// in the rail (plan structure, lint, and anchoring).
const PILL_RE = /^\[(new|breaking|risky|deletes)\](?![([])/;

marked.use({
  gfm: true,
  renderer: {
    tablerow({ text }) {
      const chosen = CHOSEN_CELL_RE.test(text);
      return `<tr${chosen ? ' class="chosen"' : ""}>\n${text}</tr>\n`;
    },
  },
  extensions: [
    {
      name: "pill",
      level: "inline",
      start(src) {
        const index = src.indexOf("[");
        return index === -1 ? undefined : index;
      },
      tokenizer(src) {
        const match = PILL_RE.exec(src);
        if (!match) return undefined;
        return { type: "pill", raw: match[0], kind: match[1]! };
      },
      renderer(token) {
        return `<span class="pill pill-${token.kind}">${token.kind}</span>`;
      },
    },
    {
      // Inline callout badges: `[!risk]` and the rest of the closed set, matched
      // anywhere in prose like a pill (BADGE_RE in callout.ts). The `!` keeps it
      // from colliding with pills or plain brackets, so order with `pill` doesn't
      // matter: `[!risk]` only ever matches here, `[new]` only the pill.
      name: "badge",
      level: "inline",
      start(src) {
        const index = src.indexOf("[!");
        return index === -1 ? undefined : index;
      },
      tokenizer(src) {
        const match = BADGE_RE.exec(src);
        if (!match) return undefined;
        return { type: "badge", raw: match[0], kind: match[1]!.toLowerCase() as CalloutType };
      },
      renderer(token) {
        return badgeHtml(token.kind);
      },
    },
  ],
});

export { marked };
