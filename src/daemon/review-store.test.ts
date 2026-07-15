import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalizeGitHubRepo } from "../shared/knowledge.js";
import {
  reviewRevisionMetadataPath,
  reviewRevisionReportPath,
  reviewRevisionSnapshotPath,
  reviewRevisionsDir,
} from "../shared/paths.js";
import { pullRequestIdentity } from "../shared/review.js";
import type { ReviewRegistrySession } from "../shared/types.js";
import { KnowledgeStore } from "./knowledge-store.js";
import {
  ReviewReportInvalidError,
  ReviewRevisionCorruptError,
  ReviewRevisionExistsError,
  ReviewStore,
} from "./review-store.js";

let home: string;
let savedHome: string | undefined;
const repository = canonicalizeGitHubRepo("acme/app")!;

function session(head = "abc123", headRevision = 1): ReviewRegistrySession {
  const identity = pullRequestIdentity(repository, 42);
  return {
    kind: "review",
    id: "otc_store1",
    title: "#42 Frozen report",
    repo: "/tmp/acme-app",
    branch: "main",
    quick: false,
    socratic: false,
    status: "working",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    review: {
      revision: headRevision,
      head: { sha: head, ref: "feature", repository, capturedAt: "2026-07-14T00:00:00.000Z" },
      pullRequest: {
        identity,
        url: "https://github.com/acme/app/pull/42",
        title: "Frozen report",
        author: "octo",
        baseRef: "main",
        headRef: "feature",
        headRepository: repository,
        headSha: head,
        state: "open",
        isCrossRepository: false,
        permissions: { maintainerCanModify: true, viewerPermission: "write", readOnly: false },
      },
    },
  };
}

function report(revision: number, snapshot: string, head = "abc123"): string {
  const group = (layer: string, title: string) => `### ${layer} — ${title}

**Purpose:** Explain why this boundary belongs in the reader's causal path.
**Changed behavior:** Calls now preserve the frozen value instead of mutable state.
**Surfaces:** \`src/example.ts#${title.replaceAll(" ", "")}\`

This paragraph explains the handoff.`;
  return `---
type: otacon-pr-review
version: 1
session: otc_store1
revision: ${revision}
pr: github.com/acme/app#42
head: ${head}
knowledge-snapshot: ${snapshot}
altitude: balanced
---

## Background

The old input could move while the report was open.
That made the explanation impossible to reproduce.

## Intuition

The snapshot is a labeled photograph of reader knowledge.
A later report can take another photograph.

## Code

Read the contract before runtime wiring.

${group("Interface changes", "Snapshot contract")}

${group("Integration path", "Capture handoff")}

${group("Implementation walkthrough", "Atomic commit")}

## Quiz

Structured cards render at this stable insertion point.
`;
}

function quiz(revision: number, head = "abc123", headRevision = 1): string {
  return JSON.stringify({
    version: 1,
    session: "otc_store1",
    revision,
    headRevision,
    headSha: head,
    questions: [{
      id: "q1",
      concept: { id: "snapshot", label: "Snapshot ownership", scope: "project" },
      prompt: "Why freeze the snapshot?",
      mode: "open",
      rubric: { criteria: ["Explains stable authorship input"] },
    }],
  });
}

beforeEach(() => {
  savedHome = process.env.OTACON_HOME;
  home = mkdtempSync(join(tmpdir(), "otacon-review-store-"));
  process.env.OTACON_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
});

describe("ReviewStore", () => {
  test("freezes auditable user and project knowledge under a stable composite hash", () => {
    const store = new ReviewStore(new KnowledgeStore(), { now: () => "2026-07-14T00:00:00.000Z" });
    const prepared = store.beginRevision(session());
    expect(prepared.revision).toMatchObject({ revision: 1, headRevision: 1, status: "prepared" });
    expect(prepared.snapshot.user.markdown).toContain("# User knowledge");
    expect(prepared.snapshot.project.markdown).toContain("github.com/acme/app");
    expect(prepared.snapshot.hash).toHaveLength(64);
    expect(store.prepareForSession(session()).snapshot.hash).toBe(prepared.snapshot.hash);
  });

  test("keeps revision one content and snapshot immutable after current knowledge changes", () => {
    const knowledge = new KnowledgeStore();
    const store = new ReviewStore(knowledge, { now: () => "2026-07-14T00:00:00.000Z" });
    const prepared = store.beginRevision(session());
    const submitted = store.submit(session(), {
      report: report(1, prepared.snapshot.hash),
      quiz: quiz(1),
    });
    const beforeBytes = readFileSync(reviewRevisionReportPath(session().id, 1), "utf8");
    const current = knowledge.read({ scope: "project", repo: repository });
    const changed = current.markdown.replace("- None yet.", "- Snapshot ownership.");
    expect(knowledge.replace({ scope: "project", repo: repository }, changed, current.hash).ok).toBe(true);
    const reread = store.readRevision(session().id, 1);
    expect(reread.snapshot.hash).toBe(prepared.snapshot.hash);
    expect(reread.snapshot.project.markdown).toBe(submitted.snapshot.project.markdown);
    expect(readFileSync(reviewRevisionReportPath(session().id, 1), "utf8")).toBe(beforeBytes);
  });

  test("supports a second report revision on the same head without overwriting the first", () => {
    const store = new ReviewStore();
    const first = store.beginRevision(session());
    store.submit(session(), { report: report(1, first.snapshot.hash), quiz: quiz(1) });
    const second = store.beginRevision(session());
    expect(second.revision).toMatchObject({ revision: 2, headRevision: 1, headSha: "abc123" });
    store.submit(session(), { report: report(2, second.snapshot.hash), quiz: quiz(2) });
    expect(store.listRevisions(session().id)).toEqual([1, 2]);
    expect(store.readRevision(session().id, 1).report).toContain("revision: 1");
    expect(store.readRevision(session().id, 2).report).toContain("revision: 2");
  });

  test("does not reuse an old report when a later head generation returns to the same SHA", () => {
    const store = new ReviewStore();
    const first = store.beginRevision(session("abc123", 1));
    store.submit(session("abc123", 1), { report: report(1, first.snapshot.hash), quiz: quiz(1) });
    expect(store.prepareForSession(session("def456", 2)).revision.revision).toBe(2);
    const reverted = store.prepareForSession(session("abc123", 3));
    expect(reverted.revision).toMatchObject({ revision: 3, headRevision: 3, headSha: "abc123" });
  });

  test("refuses invalid or duplicate submissions without changing accepted bytes", () => {
    const store = new ReviewStore();
    const prepared = store.beginRevision(session());
    expect(() => store.submit(session(), {
      report: report(1, prepared.snapshot.hash).replace("## Background", "## Intuition"),
      quiz: quiz(1),
    })).toThrow(ReviewReportInvalidError);
    const accepted = report(1, prepared.snapshot.hash);
    store.submit(session(), { report: accepted, quiz: quiz(1) });
    expect(() => store.submit(session(), { report: accepted.replace("labeled", "mutable"), quiz: quiz(1) }))
      .toThrow(ReviewRevisionExistsError);
    expect(readFileSync(reviewRevisionReportPath(session().id, 1), "utf8")).toBe(accepted);
  });

  test("refuses a prepared report after the PR head advances", () => {
    const store = new ReviewStore();
    const prepared = store.beginRevision(session());
    let thrown: ReviewReportInvalidError | undefined;
    try {
      store.submit(session("def456", 2), {
        report: report(1, prepared.snapshot.hash),
        quiz: quiz(1),
      });
    } catch (error) {
      thrown = error as ReviewReportInvalidError;
    }
    expect(thrown).toBeInstanceOf(ReviewReportInvalidError);
    expect(thrown?.issues.map((issue) => issue.code)).toContain("E_REPORT_HEAD_STALE");
    expect(existsSync(reviewRevisionReportPath(session().id, 1))).toBe(false);
  });

  test("refuses a prepared report after the head generation cycles back to the same SHA", () => {
    const store = new ReviewStore();
    const prepared = store.beginRevision(session("abc123", 1));
    store.beginRevision(session("def456", 2));
    let thrown: ReviewReportInvalidError | undefined;
    try {
      store.submit(session("abc123", 3), {
        report: report(1, prepared.snapshot.hash),
        quiz: quiz(1),
      });
    } catch (error) {
      thrown = error as ReviewReportInvalidError;
    }
    expect(thrown).toBeInstanceOf(ReviewReportInvalidError);
    expect(thrown?.issues.map((issue) => issue.code)).toContain("E_REPORT_HEAD_STALE");
    expect(existsSync(reviewRevisionReportPath(session().id, 1))).toBe(false);
  });

  test("cleans abandoned staging directories but refuses corrupt committed revisions", () => {
    const store = new ReviewStore();
    mkdirSync(join(reviewRevisionsDir(session().id), ".tmp-r1-crash"), { recursive: true });
    writeFileSync(join(reviewRevisionsDir(session().id), ".tmp-r1-crash", "partial"), "x");
    const prepared = store.beginRevision(session());
    expect(prepared.revision.revision).toBe(1);
    expect(existsSync(join(reviewRevisionsDir(session().id), ".tmp-r1-crash"))).toBe(false);
    const abandonedSubmission = join(reviewRevisionsDir(session().id), "r1", ".tmp-submission-crash");
    mkdirSync(abandonedSubmission);
    writeFileSync(join(abandonedSubmission, "partial"), "x");
    store.submit(session(), { report: report(1, prepared.snapshot.hash), quiz: quiz(1) });
    expect(existsSync(abandonedSubmission)).toBe(false);
    writeFileSync(join(reviewRevisionsDir(session().id), "r1", "user.md"), "corrupt");
    expect(() => store.readRevision(session().id, 1)).toThrow(ReviewRevisionCorruptError);
    expect(() => store.prepareForSession(session())).toThrow(ReviewRevisionCorruptError);
  });

  test("refuses revision metadata whose directory identity or project provenance was tampered", () => {
    const store = new ReviewStore();
    store.beginRevision(session());
    const metadataPath = reviewRevisionMetadataPath(session().id, 1);
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, session: "otc_other", revision: 99 }));
    expect(() => store.readRevision(session().id, 1)).toThrow(ReviewRevisionCorruptError);

    writeFileSync(metadataPath, JSON.stringify(metadata));
    const snapshotPath = reviewRevisionSnapshotPath(session().id, 1);
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    const project = snapshot.project as Record<string, unknown>;
    writeFileSync(snapshotPath, JSON.stringify({ ...snapshot, project: { ...project, repo: "ACME/APP" } }));
    expect(() => store.readRevision(session().id, 1)).toThrow(ReviewRevisionCorruptError);
  });
});
