import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalizeGitHubRepo,
  defaultKnowledgeMarkdown,
  hashKnowledge,
} from "../shared/knowledge.js";
import type { KnowledgeEvidence, KnowledgeTarget } from "../shared/knowledge.js";
import {
  projectKnowledgeEvidencePath,
  projectKnowledgePath,
  userKnowledgePath,
} from "../shared/paths.js";
import { InvalidKnowledgeMarkdownError, KnowledgeStore } from "./knowledge-store.js";

let home: string;
let savedHome: string | undefined;
let repo: ReturnType<typeof canonicalizeGitHubRepo>;
let project: KnowledgeTarget;
let store: KnowledgeStore;

beforeEach(() => {
  savedHome = process.env.OTACON_HOME;
  home = mkdtempSync(join(tmpdir(), "otacon-knowledge-"));
  process.env.OTACON_HOME = home;
  repo = canonicalizeGitHubRepo("git@github.com:Acme/App.git");
  if (repo === undefined) throw new Error("fixture repository should canonicalize");
  project = { scope: "project", repo };
  store = new KnowledgeStore();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("GitHub repository identity", () => {
  test("two clone remote spellings resolve one canonical project path", () => {
    const https = canonicalizeGitHubRepo("https://github.com/ACME/App.git");
    const ssh = canonicalizeGitHubRepo("ssh://git@github.com/acme/app.git");
    expect(String(https)).toBe("acme/app");
    expect(ssh).toBe(https);
    expect(projectKnowledgePath(https!)).toBe(projectKnowledgePath(ssh!));
  });

});

describe("summary compare-and-swap", () => {
  test("missing history reads a neutral baseline without creating a file", () => {
    const document = store.read(project);
    expect(document.markdown).toBe(defaultKnowledgeMarkdown(project));
    expect(document.hash).toBe(hashKnowledge(document.markdown));
    expect(existsSync(projectKnowledgePath(repo!))).toBe(false);
  });

  test("one writer wins and a stale writer preserves disk state", () => {
    const baseline = store.read(project);
    const first = baseline.markdown.replace("- None yet.", "- Understands CAS.");
    const won = store.replace(project, first, baseline.hash);
    expect(won.ok).toBe(true);

    const stale = store.replace(
      project,
      baseline.markdown.replace("- None yet.", "- Different draft."),
      baseline.hash,
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected conflict");
    expect(stale.current.markdown).toContain("Understands CAS");
    expect(readFileSync(projectKnowledgePath(repo!), "utf8")).not.toContain("Different draft");
  });

  test("invalid Markdown is rejected before any partial write", () => {
    const baseline = store.read({ scope: "user" });
    expect(() => store.replace({ scope: "user" }, "# Broken\n", baseline.hash)).toThrow(
      InvalidKnowledgeMarkdownError,
    );
    expect(existsSync(userKnowledgePath())).toBe(false);
  });

  test("corrupt summary is quarantined and recovers to the baseline", () => {
    const path = projectKnowledgePath(repo!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not the knowledge schema\n", { flag: "w" });
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(store.read(project).markdown).toBe(defaultKnowledgeMarkdown(project));
    } finally {
      process.stderr.write = stderr;
    }
    expect(readdirSync(join(path, "..")).some((name) => name.startsWith("knowledge.md.corrupt-"))).toBe(true);
  });
});

describe("append-only evidence", () => {
  const evidence = (id: string, verdict: "retry" | "pass"): KnowledgeEvidence => ({
    id,
    scope: "project",
    repo: repo!,
    sessionId: "otc_review1",
    pr: { number: 91, headSha: "abc123" },
    conceptId: "snapshot-boundary",
    verdict,
    rationale: verdict === "pass" ? "Explained the immutable snapshot." : "Missed revision ownership.",
    at: verdict === "pass" ? "2026-07-14T20:01:00.000Z" : "2026-07-14T20:00:00.000Z",
  });

  test("a retry followed by a pass remains as two ordered records", () => {
    store.appendEvidence(project, evidence("ke_retry", "retry"));
    store.appendEvidence(project, evidence("ke_pass", "pass"));
    const baseline = store.read(project);
    const demonstrated = baseline.markdown.replace(
      "## Demonstrated concepts\n\n- None yet.",
      "## Demonstrated concepts\n\n- Explains the immutable snapshot boundary.",
    );
    expect(store.replace(project, demonstrated, baseline.hash).ok).toBe(true);
    expect(store.readEvidence(project).map((item) => item.verdict)).toEqual(["retry", "pass"]);
    expect(store.read(project).markdown).toContain("Explains the immutable snapshot boundary");
    expect(readFileSync(projectKnowledgeEvidencePath(repo!), "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("a corrupt ledger is quarantined before a fresh append", () => {
    const path = projectKnowledgeEvidencePath(repo!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{bad json\n", { flag: "w" });
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      store.appendEvidence(project, evidence("ke_pass", "pass"));
    } finally {
      process.stderr.write = stderr;
    }
    expect(store.readEvidence(project)).toHaveLength(1);
    expect(readdirSync(join(path, "..")).some((name) => name.startsWith("evidence.jsonl.corrupt-"))).toBe(true);
  });

  test("refuses to append when a corrupt ledger cannot be quarantined", () => {
    const path = projectKnowledgeEvidencePath(repo!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{bad json\n", { flag: "w" });
    const blocked = new KnowledgeStore({ quarantine: (original) => `${original}.blocked` });
    expect(() => blocked.appendEvidence(project, evidence("ke_pass", "pass"))).toThrow(
      "could not quarantine",
    );
    expect(readFileSync(path, "utf8")).toBe("{bad json\n");
  });

  test("refuses evidence for another scope or repository", () => {
    expect(() => store.appendEvidence({ scope: "user" }, evidence("ke_wrong", "pass"))).toThrow(
      "does not match",
    );
  });
});
