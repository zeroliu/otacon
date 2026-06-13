// The single source of `marked` configuration for plan rendering: GFM plus the
// markdown-native review visuals (DESIGN.md §4). Kept free of React and
// DOMPurify so the whole transform pipeline is unit-testable without a DOM
// (markdown.test.ts) and typechecks under the no-JSX test config. markdown.tsx
// imports the configured `marked` from here, then parses + sanitizes.

import { marked } from "marked";
import { calloutHtml } from "./callout.js";

// A decision-matrix row is "chosen" when its first body cell is the ✓ marker.
// We test the already-rendered cells — header cells render as `<th>`, so the
// header row never matches, and any other table just degrades to a plain table
// (DESIGN.md §4, §10).
const CHOSEN_CELL_RE = /^\s*<td[^>]*>\s*✓/;

marked.use({
  gfm: true,
  renderer: {
    // A typed blockquote (`> [!risk]`) becomes a semantic-ink callout; every
    // other blockquote falls through to marked's default. The markup carries a
    // stable `class` and no inline styles, so it survives DOMPurify; rendering
    // the default ourselves keeps the fallback explicit and version-proof.
    blockquote(token) {
      return (
        calloutHtml(token.text) ?? `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`
      );
    },
    tablerow({ text }) {
      const chosen = CHOSEN_CELL_RE.test(text);
      return `<tr${chosen ? ' class="chosen"' : ""}>\n${text}</tr>\n`;
    },
  },
});

export { marked };
