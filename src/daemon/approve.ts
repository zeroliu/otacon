// Approved-plan artifact composition (DESIGN.md §6 step 6, §12): the final
// revision's markdown with daemon-rewritten frontmatter (status: approved,
// revision corrected — the daemon owns both) plus the grill transcript
// appended as an "## Interview" section. The artifact is post-lint output; the
// closed plan schema governs submits, not this file. Otacon never git-commits
// it — it only chooses where the file is written: always the canonical home
// store (`~/.otacon/sessions/<id>/`), and on Save also a copy under the repo's
// configured `plans.dir`. Path picking never overwrites: collisions get -2, -3, …

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptEntry } from "../shared/types.js";
import { homeSessionDir } from "../shared/paths.js";
import { slugify } from "./linter/parse.js";

/** The approve date in the user's local time — it names the artifact. */
export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The canonical home copy's absolute path:
 * `~/.otacon/sessions/<id>/YYYY-MM-DD-<slug>.md`. The session id already makes
 * the dir unique across repos, but the collision-suffix loop is kept so a
 * re-approve in the same id dir never overwrites history.
 */
export function pickHomePath(id: string, title: string, date: string): string {
  const slug = slugify(title) || "plan";
  const dir = homeSessionDir(id);
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${date}-${slug}.md` : `${date}-${slug}-${n}.md`;
    const abs = join(dir, name);
    if (!existsSync(abs)) return abs;
  }
}

/**
 * The Save-time project copy, repo-relative under the configured `plansDir`
 * (e.g. `.otacon/plans` or `docs/plans`). A taken name gets a numeric suffix so
 * a re-approved title (or a same-day twin) never overwrites history. Returns a
 * repo-relative path (the daemon joins it onto the repo root to write).
 */
export function pickProjectRelPath(
  repo: string,
  plansDir: string,
  title: string,
  date: string,
): string {
  const slug = slugify(title) || "plan";
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${date}-${slug}.md` : `${date}-${slug}-${n}.md`;
    const rel = join(plansDir, name);
    if (!existsSync(join(repo, rel))) return rel;
  }
}

/**
 * One swept comment thread rendered for the Review notes section: the reviewer's
 * comment as a blockquote (anchored to its section, or whole-plan), then the
 * agent's resolution. Multi-line bodies keep their breaks — the blockquote
 * prefixes each line, the resolution flows as paragraph text.
 */
export interface ReviewNote {
  /** Thread id (t<n>) — the audit handle that matches threads.json. */
  thread: string;
  /** The anchor's section slug, or null for a whole-plan comment. */
  section: string | null;
  /** The reviewer's comment body. */
  body: string;
  /** The agent's resolution reply (L5-required before the finalize submit). */
  resolution: string;
}

function renderReviewNote(note: ReviewNote): string {
  const where = note.section ?? "whole plan";
  const quoted = note.body
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  return [`### ${note.thread} — ${where}`, "", quoted, "", note.resolution.trim()].join("\n");
}

/** One transcript entry rendered for the Interview section. */
function renderEntry(entry: TranscriptEntry): string {
  const lines = [`### ${entry.id} — ${entry.question.replace(/\s+/g, " ").trim()}`, ""];
  if (entry.options) {
    const labeled = entry.options.map((o) =>
      o === entry.recommend ? `${o} (recommended)` : o,
    );
    lines.push(`- Options${entry.multi ? " (multi)" : ""}: ${labeled.join(" | ")}`);
  }
  const { answer } = entry;
  if (!answer) {
    lines.push("- Answer: _unanswered_");
  } else {
    const picked = answer.choices?.join(", ") ?? answer.choice;
    const text = answer.text?.trim();
    const body = picked !== undefined && text ? `${picked} — ${text}` : (picked ?? text ?? "");
    // Multi-line free text stays inside the bullet via continuation indent.
    lines.push(`- Answer: ${body.split("\n").join("\n  ")}`);
  }
  return lines.join("\n");
}

/**
 * The approved artifact: frontmatter `status`/`revision` rewritten to the
 * daemon's truth, then the grill transcript as "## Interview" (omitted when
 * the transcript is empty — a --quick session has no interview to ship), then —
 * only when the approval went through **comment & approve** — a "## Review notes"
 * section recording the comments the agent folded in unreviewed and how it
 * resolved them, so the trusted fold-in stays auditable (DESIGN.md §12). A plain
 * or force approve carries no `reviewNotes`, so the section is omitted.
 */
export function composeArtifact(
  markdown: string,
  opts: { revision: number; entries: TranscriptEntry[]; reviewNotes?: ReviewNote[] },
): string {
  const lines = markdown.split("\n");
  // Every stored revision passed L1, so the frontmatter block and both keys
  // exist; the scan still degrades safely (no rewrite) if they do not.
  const close = lines[0]?.trim() === "---" ? lines.findIndex((l, i) => i > 0 && l.trim() === "---") : -1;
  for (let i = 1; i < close; i++) {
    if (/^status:/.test(lines[i] ?? "")) lines[i] = "status: approved";
    else if (/^revision:/.test(lines[i] ?? "")) lines[i] = `revision: ${opts.revision}`;
  }
  let out = lines.join("\n");
  if (opts.entries.length > 0) {
    const interview = opts.entries.map(renderEntry).join("\n\n");
    out = `${out.replace(/\n*$/, "\n")}\n## Interview\n\n${interview}\n`;
  }
  if (opts.reviewNotes && opts.reviewNotes.length > 0) {
    const notes = opts.reviewNotes.map(renderReviewNote).join("\n\n");
    const intro =
      "_The reviewer approved with these comments open and sent them to the agent; it folded them in on a final solo pass — recorded here for the trail._";
    out = `${out.replace(/\n*$/, "\n")}\n## Review notes\n\n${intro}\n\n${notes}\n`;
  }
  return out;
}
