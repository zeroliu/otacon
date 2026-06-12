// Approved-plan artifact composition (DESIGN.md §6 step 6, §12): the final
// revision's markdown with daemon-rewritten frontmatter (status: approved,
// revision corrected — the daemon owns both) plus the grill transcript
// appended as an "## Interview" section. The artifact is post-lint output the
// agent commits to docs/plans/; the closed plan schema governs submits, not
// this file. Path picking never overwrites: name collisions get -2, -3, …

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptEntry } from "../shared/types.js";
import { plansDir } from "../shared/paths.js";
import { slugify } from "./linter/parse.js";

/** The approve date in the user's local time — it names the artifact. */
export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * docs/plans/YYYY-MM-DD-<slug>.md, repo-relative; a taken name gets a numeric
 * suffix so a re-approved title (or a same-day twin) never overwrites history.
 */
export function pickArtifactRelPath(repo: string, title: string, date: string): string {
  const slug = slugify(title) || "plan";
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${date}-${slug}.md` : `${date}-${slug}-${n}.md`;
    if (!existsSync(join(plansDir(repo), name))) return join("docs", "plans", name);
  }
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
 * The committed artifact: frontmatter `status`/`revision` rewritten to the
 * daemon's truth, then the grill transcript as "## Interview" (omitted when
 * the transcript is empty — a --quick session has no interview to ship).
 */
export function composeArtifact(
  markdown: string,
  opts: { revision: number; entries: TranscriptEntry[] },
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
  return out;
}
