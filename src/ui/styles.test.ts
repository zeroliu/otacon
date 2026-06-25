// Guards the type-scale floor (DECISIONS.md "12px type-scale floor"): no font
// declaration in styles.css may specify a size below 12px. The look (mono,
// uppercase, tracking, color) is preserved; only the legible-size floor is
// enforced here. Reads the stylesheet straight off disk (no DOM, no Vite) and
// scans only `font:`/`font-size:` declarations. Border/padding/width legitimately
// use sub-12px px, so they are out of scope. Token definitions (`--fs-*: 12px`)
// have property names that are not font/font-size, so they are skipped naturally;
// token usages (`var(--fs-meta)`) carry no px literal, so they pass.
//
// A second test pins the 5-role semantic type scale (DECISIONS.md "5-role
// semantic type scale") so the :root token set cannot silently drift: exactly
// five tokens, exact px values, and the retired names (--fs-prose/--fs-label)
// must never reappear.

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

test("the :root type scale is exactly the five semantic role tokens", () => {
  // Isolate the first :root block so we read the canonical token definitions,
  // not any var() usages or dark-mode overrides further down the file.
  const rootMatch = /:root\s*\{([\s\S]*?)\}/.exec(css);
  expect(rootMatch, ":root block not found in styles.css").not.toBeNull();
  const root = rootMatch?.[1] ?? "";

  // The retired names must not come back, in :root or anywhere else.
  expect(css.includes("--fs-prose"), "retired token --fs-prose reappeared").toBe(false);
  expect(css.includes("--fs-label"), "retired token --fs-label reappeared").toBe(false);

  const EXPECTED = {
    "--fs-meta": 12,
    "--fs-ui": 14,
    "--fs-body": 16,
    "--fs-title": 18,
    "--fs-display": 22,
  };

  // Collect every --fs-* definition (a property name, not a var() usage) from
  // the canonical first :root into name -> px value, and confirm it is exactly
  // the five-role scale at the five expected px values.
  const DEF = /--fs-([a-z][a-z0-9-]*)\s*:\s*(\d+(?:\.\d+)?)px/g;
  const scale: Record<string, number> = {};
  let def: RegExpExecArray | null;
  DEF.lastIndex = 0;
  while ((def = DEF.exec(root)) !== null) {
    const name = `--fs-${def[1]}`;
    scale[name] = Number.parseFloat(def[2] ?? "");
  }

  expect(scale).toEqual(EXPECTED);

  // A --fs-* token may be redefined later in the file (e.g. the dark-mode :root),
  // but only ever to its canonical value. This catches an off-16 --fs-body (or any
  // other off-scale redefinition) that sits at or above the 12px floor and so would
  // slip past the floor guard above.
  DEF.lastIndex = 0;
  let anyDef: RegExpExecArray | null;
  while ((anyDef = DEF.exec(css)) !== null) {
    const name = `--fs-${anyDef[1]}` as keyof typeof EXPECTED;
    const px = Number.parseFloat(anyDef[2] ?? "");
    expect(EXPECTED[name], `unknown --fs token redefined: ${name}`).not.toBeUndefined();
    expect(px, `${name} redefined off its canonical value`).toBe(EXPECTED[name]);
  }
});

test("every sub-1em / sub-100% font size is clamped with max(12px, …)", () => {
  // The em-relative floor (DECISIONS.md "5-role semantic type scale"): inline
  // sizes that scale below their context (a sub-1.0 `em` multiplier or a
  // sub-100% percentage, e.g. inline code at 0.92em, scope pills at 0.8em)
  // can drop below the 12px legibility floor when their inherited size is small.
  // Each MUST be wrapped in a max(12px, …) clamp so the rendered size never
  // falls under the floor. A bare `font-size: 0.8em;` fails here; the clamped
  // `font-size: max(12px, 0.8em);` passes. Absolute px/var() sizes carry no
  // sub-1 multiplier and so are not matched.
  //
  // A sub-1.0 em is `[0].\d+ em` (e.g. 0.8em, .8em). A sub-100% is a 1-2 digit
  // integer or fractional percent (e.g. 90%, 7.5%). The `(?<![\d.])` lookbehind
  // pins the start of the number so we do NOT misread the `.5em` inside a
  // legitimate `1.5em`, or the `50%` inside `150%`, as a sub-floor size.
  const SUB_ONE = /(?<![\d.])0?\.\d+em|(?<![\d.])\d{1,2}(?:\.\d+)?%/;
  const offenders: string[] = [];

  let lineNo = 1;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  FONT_DECL.lastIndex = 0;
  while ((match = FONT_DECL.exec(css)) !== null) {
    lineNo += countNewlines(css.slice(lastIndex, match.index));
    lastIndex = match.index;

    const prop = match[1] ?? "font";
    const value = (match[2] ?? "").trim();

    // Look for a sub-1.0 em multiplier or a sub-100% percentage anywhere in the
    // declaration. A two-digit-or-less integer percent (or a fractional one) is
    // always below 100%; a leading-zero/bare decimal em (0.x em) is below 1.0.
    const subOne = SUB_ONE.test(value);
    if (!subOne) continue;

    // Clamped if the offending size sits inside a max(12px, …) expression.
    const clamped = /max\(\s*12px\s*,/.test(value);
    if (!clamped) {
      offenders.push(`line ${lineNo}: ${prop}: ${value}; → sub-1em/sub-100% size not clamped with max(12px, …)`);
    }
  }

  expect(
    offenders,
    `un-clamped sub-1em/sub-100% font sizes found:\n${offenders.join("\n")}`,
  ).toEqual([]);
});

test("no font SIZE outside :root is a px literal (except max(12px, …) clamps)", () => {
  // The final guard (DECISIONS.md "5-role semantic type scale"): once the scale
  // is fully wired, every font SIZE outside the token block(s) must be a
  // var(--fs-*) token or an intentional max(12px, …) inline floor, never a bare
  // px literal. This is what keeps the five roles the single source of truth for
  // size; a stray `font-size: 17px;` would silently fork the scale.
  //
  // Scope notes:
  //  - The :root block(s) hold the canonical `--fs-*: <px>` definitions, so they
  //    are stripped before scanning (they legitimately carry px). :root carries
  //    no nested braces, so a `[^{}]*` body match removes each block cleanly.
  //  - In a `font:` shorthand the px we care about is the SIZE, the token before
  //    an optional `/<line-height>`. A px in the `/<lh>` position (e.g. the `/1`
  //    in `var(--fs-display)/1` is a var, but a literal `16px/20px` line-height
  //    px) is out of scope: only the SIZE must be tokenised. We isolate the size
  //    by cutting the value at the first `/` that is not inside parentheses.
  //  - max(12px, …) is the sanctioned inline clamp (code, pills, q-cite); a px
  //    that lives inside such a max(…) is allowed.
  const noRoot = css.replace(/:root\s*\{[^{}]*\}/g, "");

  const offenders: string[] = [];
  let lineNo = 1;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  FONT_DECL.lastIndex = 0;
  while ((match = FONT_DECL.exec(noRoot)) !== null) {
    lineNo += countNewlines(noRoot.slice(lastIndex, match.index));
    lastIndex = match.index;

    const prop = match[1] ?? "font";
    const value = (match[2] ?? "").trim();

    // Isolate the SIZE portion. For `font-size:` it is the whole value. For the
    // `font:` shorthand the size is everything before the first top-level `/`
    // (the size/line-height separator); a `/` nested inside parentheses, were
    // one to appear, is skipped via a paren-depth counter.
    let size = value;
    if (prop === "font") {
      let depth = 0;
      for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (ch === "/" && depth === 0) {
          size = value.slice(0, i);
          break;
        }
      }
    }

    // Remove every max(12px, …) clamp from the size so its 12px is not counted,
    // then any surviving px in the size position is a forbidden literal.
    const sizeNoClamp = size.replace(/max\(\s*12px\s*,[^)]*\)/g, "");
    if (/\d+(?:\.\d+)?px/.test(sizeNoClamp)) {
      offenders.push(`line ${lineNo}: ${prop}: ${value}; → size carries a px literal (use var(--fs-*) or max(12px, …))`);
    }
  }

  expect(
    offenders,
    `px font sizes found outside :root:\n${offenders.join("\n")}`,
  ).toEqual([]);
});

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}
