import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiResponse } from "../client.js";
import { CliError } from "../output.js";
import type { ReviewCommandDeps } from "./review.js";
import { reviewCommand } from "./review.js";

let repo: string;
let savedHome: string | undefined;

const ghPayload = (repository = "acme/app", head = "a".repeat(40)) => JSON.stringify({
  number: 42,
  url: `https://github.com/${repository}/pull/42`,
  title: "Typed sessions",
  author: { login: "octo" },
  baseRefName: "main",
  headRefName: "feature",
  headRefOid: head,
  headRepository: { nameWithOwner: repository, name: repository.split("/")[1] },
  headRepositoryOwner: { login: repository.split("/")[0] },
  state: "OPEN",
  isCrossRepository: false,
  maintainerCanModify: true,
});

beforeEach(() => {
  savedHome = process.env.OTACON_HOME;
  process.env.OTACON_HOME = realpathSync(mkdtempSync(join(tmpdir(), "otacon-review-home-")));
  repo = realpathSync(mkdtempSync(join(tmpdir(), "otacon-review-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(process.env.OTACON_HOME as string, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
});

function deps(options: {
  ghRepo?: string;
  api?: (method: string, path: string, body?: unknown) => Promise<ApiResponse>;
  ensure?: () => Promise<unknown>;
} = {}): ReviewCommandDeps {
  return {
    cwd: () => repo,
    ensureDaemon: options.ensure ?? (async () => undefined),
    api: options.api ?? (async () => ({ status: 500, body: {} })),
    github: {
      run: (command, args) => command === "git"
        ? "git@github.com:Acme/App.git"
        : args[0] === "pr"
          ? ghPayload(options.ghRepo ?? "acme/app")
          : JSON.stringify({ viewerPermission: "WRITE" }),
    },
  };
}

async function capture(argv: string[], commandDeps: ReviewCommandDeps): Promise<Record<string, unknown>> {
  const write = process.stdout.write;
  let printed: Record<string, unknown> = {};
  process.stdout.write = ((chunk: string | Uint8Array) => {
    printed = JSON.parse(String(chunk)) as Record<string, unknown>;
    return true;
  }) as typeof process.stdout.write;
  try {
    expect(await reviewCommand(argv, commandDeps)).toBe(0);
    return printed;
  } finally {
    process.stdout.write = write;
  }
}

describe("review start", () => {
  test("prints create action plus report, quiz, and knowledge paths", async () => {
    let wire: Record<string, unknown> = {};
    const printed = await capture(["start", "--pr", "42", "--force"], deps({
      api: async (_method, path, body) => {
        expect(path).toBe("/api/reviews");
        wire = body as Record<string, unknown>;
        const pullRequest = wire.pullRequest as Record<string, unknown>;
        return {
          status: 201,
          body: {
            action: "created",
            preparation: {
              revision: {
                version: 1,
                session: "otc_review1",
                revision: 1,
                headRevision: 1,
                headSha: pullRequest.headSha,
                snapshotHash: "f".repeat(64),
                createdAt: "2026-07-14T00:00:00.000Z",
                status: "prepared",
              },
              snapshot: {
                version: 1,
                session: "otc_review1",
                revision: 1,
                headRevision: 1,
                headSha: pullRequest.headSha,
                capturedAt: "2026-07-14T00:00:00.000Z",
                hash: "f".repeat(64),
                user: { hash: "a".repeat(64), markdown: "user" },
                project: { repo: "acme/app", hash: "b".repeat(64), markdown: "project" },
              },
              warnings: [],
            },
            session: {
              kind: "review",
              id: "otc_review1",
              title: "#42 Typed sessions",
              repo,
              branch: "main",
              quick: false,
              socratic: false,
              status: "working",
              createdAt: "now",
              updatedAt: "now",
              review: {
                pullRequest,
                head: { sha: pullRequest.headSha, ref: "feature", repository: "acme/app", capturedAt: "now" },
                revision: 1,
              },
            },
          },
        };
      },
    }));
    expect(wire.repository).toBe("acme/app");
    expect(wire.force).toBe(true);
    expect(printed.action).toBe("created");
    expect(String(printed.report)).toContain("/sessions/otc_review1/review.md");
    expect(String(printed.quiz)).toContain("/sessions/otc_review1/quiz.json");
    expect(printed.revision).toBe(1);
    expect(printed.headRevision).toBe(1);
    expect(printed.knowledge).toEqual(expect.objectContaining({
      current: {
        user: expect.stringContaining("/knowledge/user.md"),
        project: expect.stringContaining("/knowledge/projects/github.com/acme/app/knowledge.md"),
      },
      snapshot: expect.objectContaining({
        hash: "f".repeat(64),
        user: expect.objectContaining({ path: expect.stringContaining("/review/revisions/r1/user.md") }),
        project: expect.objectContaining({ path: expect.stringContaining("/review/revisions/r1/project.md") }),
      }),
    }));
  });

  test("repo mismatch fails before daemon contact or API creation", async () => {
    let ensured = 0;
    let apiCalls = 0;
    const commandDeps = deps({
      ghRepo: "other/repo",
      ensure: async () => { ensured += 1; },
      api: async () => { apiCalls += 1; return { status: 500, body: {} }; },
    });
    let error: unknown;
    try {
      await reviewCommand(["start", "--pr", "https://github.com/other/repo/pull/42"], commandDeps);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("E_REPO_MISMATCH");
    expect(ensured).toBe(0);
    expect(apiCalls).toBe(0);
  });
});

describe("review submit", () => {
  const report = `---
type: otacon-pr-review
version: 1
session: otc_review1
revision: 1
pr: github.com/acme/app#42
head: abc
knowledge-snapshot: ${"f".repeat(64)}
altitude: balanced
---

## Background

Background.

## Intuition

Intuition.

## Code

### Interface changes — Contract

**Purpose:** Purpose long enough for the report.
**Changed behavior:** Changed behavior long enough for the report.
**Surfaces:** \`src/a.ts#A\`

### Integration path — Wiring

**Purpose:** Purpose long enough for the report.
**Changed behavior:** Changed behavior long enough for the report.
**Surfaces:** \`src/b.ts#B\`

### Implementation walkthrough — Internals

**Purpose:** Purpose long enough for the report.
**Changed behavior:** Changed behavior long enough for the report.
**Surfaces:** \`src/c.ts#C\`

## Quiz
`;

  test("reads report and quiz files, derives the session, and prints the persisted revision", async () => {
    const reportPath = join(repo, "report.md");
    const quizPath = join(repo, "quiz.json");
    writeFileSync(reportPath, report);
    writeFileSync(quizPath, "{}\n");
    let wire: Record<string, unknown> | undefined;
    const printed = await capture(["submit", "--report", reportPath, "--quiz", quizPath], deps({
      api: async (method, path, body) => {
        expect(method).toBe("POST");
        expect(path).toBe("/api/reviews/otc_review1/submit");
        wire = body as Record<string, unknown>;
        return {
          status: 201,
          body: {
            revision: {
              revision: {
                version: 1,
                session: "otc_review1",
                revision: 1,
                headRevision: 3,
                headSha: "abc",
                snapshotHash: "f".repeat(64),
                createdAt: "2026-07-14T00:00:00.000Z",
                submittedAt: "2026-07-14T00:01:00.000Z",
                status: "submitted",
              },
              snapshot: {
                version: 1,
                session: "otc_review1",
                revision: 1,
                headRevision: 3,
                headSha: "abc",
                capturedAt: "2026-07-14T00:00:00.000Z",
                hash: "f".repeat(64),
                user: { hash: "a".repeat(64), markdown: "user" },
                project: { repo: "acme/app", hash: "b".repeat(64), markdown: "project" },
              },
              report,
              quiz: {},
              warnings: [],
            },
          },
        };
      },
    }));
    expect(wire?.report).toBe(report);
    expect(wire?.quiz).toBe("{}\n");
    expect(printed).toMatchObject({ ok: true, session: "otc_review1", revision: 1, headRevision: 3 });
  });

  test("surfaces daemon lint issues with line-aware actionable output", async () => {
    const reportPath = join(repo, "report.md");
    const quizPath = join(repo, "quiz.json");
    writeFileSync(reportPath, report);
    writeFileSync(quizPath, "{}\n");
    let error: CliError | undefined;
    try {
      await reviewCommand(["submit", "--report", reportPath, "--quiz", quizPath], deps({
        api: async () => ({
          status: 422,
          body: { issues: [{ code: "E_REPORT_SECTION_ORDER", line: 14, message: "required order" }] },
        }),
      }));
    } catch (caught) {
      error = caught as CliError;
    }
    expect(error).toBeInstanceOf(CliError);
    expect(error?.code).toBe("E_REVIEW_REPORT_INVALID");
    expect(error?.message).toContain("line 14: E_REPORT_SECTION_ORDER required order");
    expect(error?.extra.issues).toHaveLength(1);
  });

  test("preserves typed missing-session errors instead of reporting an internal failure", async () => {
    const reportPath = join(repo, "report.md");
    const quizPath = join(repo, "quiz.json");
    writeFileSync(reportPath, report);
    writeFileSync(quizPath, "{}\n");
    let error: CliError | undefined;
    try {
      await reviewCommand(["submit", "--report", reportPath, "--quiz", quizPath], deps({
        api: async () => ({ status: 404, body: { error: { code: "E_NOT_FOUND", message: "unknown session" } } }),
      }));
    } catch (caught) {
      error = caught as CliError;
    }
    expect(error?.code).toBe("E_NOT_FOUND");
    expect(error?.message).toBe("unknown session");
  });
});
