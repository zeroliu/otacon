// Guards the type-scale floor (DECISIONS.md "12px type-scale floor"): no font
// declaration in styles.css may specify a size below 12px. The look (mono,
// uppercase, tracking, color) is preserved; only the legible-size floor is
// enforced here. Reads the stylesheet straight off disk (no DOM, no Vite) and
// scans only `font:`/`font-size:` declarations. Border/padding/width legitimately
// use sub-12px px, so they are out of scope. Token definitions (`--fs-*: 12px`)
// have property names that are not font/font-size, so they are skipped naturally;
// token usages (`var(--fs-label)`) carry no px literal, so they pass.

import { readFileSync } from "node:fs";
import { test, expect } from "bun:test";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

// A `font:` shorthand or a `font-size:` longhand, capturing everything up to the
// declaration's terminating semicolon. We exclude custom-property definitions by
// matching the literal property names only.
const FONT_DECL = /(?:^|[\s;{])(font-size|font)\s*:\s*([^;{}]+);/g;
const PX = /(\d+(?:\.\d+)?)px/g;
const FLOOR = 12;

test("no font declaration renders below the 12px type-scale floor", () => {
  const offenders: string[] = [];

  // Track 1-based line numbers so a regression points at the offending line.
  let lineNo = 1;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  FONT_DECL.lastIndex = 0;
  while ((match = FONT_DECL.exec(css)) !== null) {
    lineNo += countNewlines(css.slice(lastIndex, match.index));
    lastIndex = match.index;

    const prop = match[1] ?? "font";
    const value = (match[2] ?? "").trim();
    // Both the size and any px line-height should clear the floor, so check
    // every px literal in the declaration, robust against the shorthand's
    // `size/line-height` form.
    let px: RegExpExecArray | null;
    PX.lastIndex = 0;
    while ((px = PX.exec(value)) !== null) {
      const raw = px[1] ?? "";
      const size = Number.parseFloat(raw);
      if (size < FLOOR) {
        offenders.push(`line ${lineNo}: ${prop}: ${value}; → ${raw}px is below ${FLOOR}px`);
      }
    }
  }

  expect(offenders, `sub-${FLOOR}px font sizes found:\n${offenders.join("\n")}`).toEqual([]);
});

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}
