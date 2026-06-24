// Drift reconciliation (verify-before-merge, Phase 3): surface implementation
// that exceeds the approved plan. At implement-done the CLI computes the source
// files the build changed (git, in the worktree), the daemon extracts the files
// the approved plan's per-phase `Files:` lists cite, and `reconcile` flags any
// changed file no phase cites. This is ADVISORY and reviewer-facing: it never
// blocks implement-done (drift over-/under-reports on rebases and squashes, so
// it must inform, not gate). The git probe and the parse/match are split so the
// pure functions (citedPaths, reconcile) are exhaustively unit-testable without
// a repo.

import { execFileSync } from "node:child_process";
import type { Reconciliation } from "../shared/types.js";

/** Shell git exactly as session.ts does (execFileSync, stderr ignored): a
 *  trimmed stdout string, or undefined on any non-zero exit / missing binary. */
function git(repoDir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The repo-relative source paths the build changed vs its merge-base with
 * `baseBranch`: `git diff --name-only <merge-base baseBranch HEAD> HEAD`, run
 * in the build worktree. Fails SOFT: a missing merge-base, a detached HEAD, or
 * a non-repo all return [] so reconciliation degrades to empty rather than
 * throwing. Drift is advisory and must never break implement-done.
 */
export function changedFiles(repoDir: string, baseBranch = "main"): string[] {
  const base = git(repoDir, ["merge-base", baseBranch, "HEAD"]);
  if (!base) return [];
  const out = git(repoDir, ["diff", "--name-only", base, "HEAD"]);
  if (out === undefined || out === "") return [];
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

// Scope pills the plan grammar allows on a Files entry (`[new]`, `[breaking]`,
// …), stripped so the bare path matches the changed-file path.
const PILL_RE = /\[[^\]]*\]/g;

/**
 * Normalize one raw `Files:` list item to a bare repo-relative path: strip a
 * leading `- `/`* `, surrounding backticks, scope pills (`[new]` etc), and any
 * trailing description after ` — ` or ` (`. Returns "" for an item that carries
 * no path (a pure description line), which the caller drops.
 */
function normalizeCited(raw: string): string {
  let s = raw.trim().replace(/^[-*+]\s+/, "");
  // A backtick-quoted path is the whole path; anything after the closing
  // backtick is description (`- \`*.test.ts\` for the above`). This is the most
  // common Files-item form, so honoring it strips trailing prose that has no
  // ` — `/` (` separator.
  const quoted = /^`([^`]+)`/.exec(s);
  if (quoted) return quoted[1]!.trim().replace(/\/+$/, "");
  // Unquoted: a path never contains " — " or " (", so the first one begins the
  // prose. Cut before scope-pill stripping so a `(note)` can't leak.
  const dash = s.indexOf(" — ");
  if (dash !== -1) s = s.slice(0, dash);
  const paren = s.indexOf(" (");
  if (paren !== -1) s = s.slice(0, paren);
  s = s.replace(PILL_RE, "");
  s = s.replace(/`/g, "");
  return s.trim().replace(/\/+$/, "");
}

// The plan field grammar (mirrors daemon/linter/parse.ts): `Files:` in any of
// `Files:`, `**Files**:`, `**Files:**`; a list item is `- `/`* `/`+ `; any
// other field label (Goal/Verification/Out of scope) or a heading closes the
// list. Parsed directly here (not via parsePlan) because the parser captures
// only field line-counts, not the raw item paths this needs.
const FILES_LABEL_RE = /^(?:\*\*)?Files(?:\*\*)?:(?:\*\*)?\s*(.*)$/;
const OTHER_FIELD_RE = /^(?:\*\*)?(?:Goal|Verification|Out of scope)(?:\*\*)?:/;
const LIST_ITEM_RE = /^[-*+]\s+/;
const HEADING_RE = /^#{1,6}\s/;

/**
 * Every bare path cited in any phase's `Files:` list across the plan markdown.
 * Walks the lines, opening a Files run on a `Files:` label and closing it on the
 * next field label, heading, or blank-after-content; collects each list item's
 * normalized path. Lenient by design (over-collecting cited paths only shrinks
 * the advisory drift list, never grows a false positive).
 */
export function citedPaths(planMarkdown: string): string[] {
  const cited: string[] = [];
  let inFiles = false;
  let sawItem = false;
  for (const line of planMarkdown.split("\n")) {
    if (HEADING_RE.test(line) || OTHER_FIELD_RE.test(line)) {
      inFiles = false;
      sawItem = false;
    }
    const label = FILES_LABEL_RE.exec(line);
    if (label) {
      inFiles = true;
      sawItem = false;
      // A `Files: a.ts, b.ts` inline form (rare): take the trailing text too.
      const inline = label[1]?.trim();
      if (inline) {
        for (const part of inline.split(",")) {
          const path = normalizeCited(part);
          if (path) cited.push(path);
        }
      }
      continue;
    }
    if (!inFiles) continue;
    if (line.trim() === "") {
      // A blank line BEFORE the first item is the optional gap after the label
      // (rich-plan style); a blank AFTER items ends the list.
      if (sawItem) inFiles = false;
      continue;
    }
    if (LIST_ITEM_RE.test(line)) {
      sawItem = true;
      const path = normalizeCited(line);
      if (path) cited.push(path);
      continue;
    }
    // A continuation line under an item (or stray prose), not a new path; the
    // list keeps running until a field/heading/blank-after-content closes it.
  }
  return Array.from(new Set(cited));
}

/** Does a `*`/`**` glob (cited) cover the changed path? `**` spans `/`, a lone
 *  `*` does not, enough for the `src/**` / `src/*.ts` forms a Files list uses. */
function globMatches(glob: string, path: string): boolean {
  if (!glob.includes("*")) return false;
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*");
  const rx = new RegExp(`^${re}$`);
  if (rx.test(path)) return true;
  // A glob with no `/` (`*.test.ts`) also matches the path basename, so a
  // bare extension glob covers a test file in any directory. Leniency by
  // design: this advisory signal favours "covered" to avoid false positives,
  // and a plan author writing `*.test.ts` means tests anywhere.
  if (!glob.includes("/")) return rx.test(path.slice(path.lastIndexOf("/") + 1));
  return false;
}

/** Is the changed file covered by any cited path? Lenient (minimize false
 *  positives on this advisory signal): an exact match, a cited-directory prefix
 *  (`cited + "/"`), or a `*`/`**` glob all count as covered. */
function isCovered(changed: string, cited: string[]): boolean {
  return cited.some(
    (c) => c === changed || changed.startsWith(`${c}/`) || globMatches(c, changed),
  );
}

/**
 * The reconciliation report: every changed file no cited path covers, in the
 * changed-files order. Empty when every change is covered. Advisory only:
 * surfaced to the reviewer (response + UI callout), never enforced.
 */
export function reconcile(changed: string[], cited: string[]): Reconciliation {
  return { shippedBeyondPlan: changed.filter((f) => !isCovered(f, cited)) };
}
