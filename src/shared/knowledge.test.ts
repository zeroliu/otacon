import { describe, expect, test } from "bun:test";
import {
  canonicalizeGitHubRepo,
  defaultKnowledgeMarkdown,
  hashKnowledge,
  isKnowledgeEvidence,
  KNOWLEDGE_SECTIONS,
  normalizeKnowledgeMarkdown,
  parseKnowledgeHash,
  validateKnowledgeMarkdown,
} from "./knowledge.js";
import type { KnowledgeEvidence, KnowledgeTarget } from "./knowledge.js";

const canonicalRepo = () => {
  const repo = canonicalizeGitHubRepo("acme/app");
  if (repo === undefined) throw new Error("fixture repository should canonicalize");
  return repo;
};

describe("canonical GitHub repository identity", () => {
  test("normalizes every supported agent, URL, and git-remote spelling", () => {
    for (const input of [
      "Acme/App",
      "github.com/Acme/App",
      "https://github.com/Acme/App.git",
      "http://github.com/acme/app/",
      "git@github.com:Acme/App.git",
      "ssh://git@github.com/Acme/App.git",
    ]) {
      expect(String(canonicalizeGitHubRepo(input))).toBe("acme/app");
    }
  });

  test("rejects foreign hosts, traversal, extra segments, and malformed names", () => {
    for (const input of [
      "",
      "https://gitlab.com/acme/app",
      "acme/../app",
      "acme/app/issues",
      "-acme/app",
      "acme/repo name",
      "https://github.com/acme",
    ]) {
      expect(canonicalizeGitHubRepo(input)).toBeUndefined();
    }
  });
});

describe("knowledge Markdown contract", () => {
  test("normalizes line endings and exactly one terminal newline", () => {
    expect(normalizeKnowledgeMarkdown("# Title\r\n\rBody\r\n\r\n")).toBe(
      "# Title\n\nBody\n",
    );
    expect(normalizeKnowledgeMarkdown("one line")).toBe("one line\n");
  });

  test("accepts the standard ordered sections and rejects structural drift", () => {
    const valid = defaultKnowledgeMarkdown({ scope: "user" });
    expect(validateKnowledgeMarkdown(valid)).toBeUndefined();
    expect(validateKnowledgeMarkdown(valid.replace("# User knowledge", "intro\n# User knowledge"))).toBe(
      "Markdown must start with a level-one title",
    );
    expect(validateKnowledgeMarkdown(valid.replace("## Code exposure", "## Other"))).toContain(
      "exactly one \"## Code exposure\"",
    );
    expect(validateKnowledgeMarkdown(valid.replace(
      "## Preferences\n\n- No preferences recorded yet.\n\n## Demonstrated concepts",
      "## Demonstrated concepts\n\n- None yet.\n\n## Preferences",
    ))).toBe("knowledge sections must use the standard order");
    expect(validateKnowledgeMarkdown(`${valid}\n## Preferences\n`)).toContain(
      "exactly one \"## Preferences\"",
    );
  });

  test("default user and project documents carry the complete valid schema", () => {
    const targets: KnowledgeTarget[] = [
      { scope: "user" },
      { scope: "project", repo: canonicalRepo() },
    ];
    for (const target of targets) {
      const markdown = defaultKnowledgeMarkdown(target);
      expect(validateKnowledgeMarkdown(markdown)).toBeUndefined();
      for (const section of KNOWLEDGE_SECTIONS) expect(markdown).toContain(`## ${section}`);
      expect(markdown.endsWith("\n")).toBe(true);
    }
    expect(defaultKnowledgeMarkdown(targets[0]!)).toStartWith("# User knowledge\n");
    expect(defaultKnowledgeMarkdown(targets[1]!)).toStartWith(
      "# Project knowledge — github.com/acme/app\n",
    );
  });
});

describe("typed knowledge hashes", () => {
  test("hashing is deterministic and content-sensitive", () => {
    const first = hashKnowledge("same bytes\n");
    expect(first).toBe(hashKnowledge("same bytes\n"));
    expect(first).not.toBe(hashKnowledge("different bytes\n"));
    expect(String(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("only lowercase 64-character SHA-256 strings parse", () => {
    const valid = "a".repeat(64);
    expect(String(parseKnowledgeHash(valid))).toBe(valid);
    expect(parseKnowledgeHash("a".repeat(63))).toBeUndefined();
    expect(parseKnowledgeHash("A".repeat(64))).toBeUndefined();
    expect(parseKnowledgeHash("z".repeat(64))).toBeUndefined();
  });
});

describe("knowledge evidence validation", () => {
  const base = (): KnowledgeEvidence => ({
    id: "ke_1",
    scope: "user",
    sessionId: "otc_review1",
    conceptId: "snapshot-boundary",
    verdict: "retry",
    rationale: "Missed who owns the snapshot.",
    at: "2026-07-14T20:00:00.000Z",
  });

  test("accepts user and canonical-project evidence with optional PR provenance", () => {
    expect(isKnowledgeEvidence(base())).toBe(true);
    expect(isKnowledgeEvidence({
      ...base(),
      scope: "project",
      repo: canonicalRepo(),
      verdict: "pass",
      pr: { number: 91, headSha: "abc123" },
    })).toBe(true);
  });

  test("rejects target mismatches, invalid verdict/time, and malformed PR provenance", () => {
    expect(isKnowledgeEvidence({ ...base(), repo: canonicalRepo() })).toBe(false);
    expect(isKnowledgeEvidence({ ...base(), scope: "project" })).toBe(false);
    expect(isKnowledgeEvidence({ ...base(), scope: "project", repo: "ACME/App" })).toBe(false);
    expect(isKnowledgeEvidence({ ...base(), verdict: "maybe" })).toBe(false);
    expect(isKnowledgeEvidence({ ...base(), at: "not-a-date" })).toBe(false);
    expect(isKnowledgeEvidence({ ...base(), pr: { number: 0, headSha: "" } })).toBe(false);
    expect(isKnowledgeEvidence({ ...base(), id: "" })).toBe(false);
  });
});
