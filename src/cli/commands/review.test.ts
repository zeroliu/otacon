import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiResponse } from "../client.js";
import { CliError } from "../output.js";
import type { ReviewWorktreeDeps } from "../review-worktree.js";
import type { ReviewRegistrySession } from "../../shared/types.js";
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
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(process.env.OTACON_HOME as string, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
});

function deps(options: {
  ghRepo?: string;
  ghHead?: string;
  viewerPermission?: string;
  api?: (method: string, path: string, body?: unknown) => Promise<ApiResponse>;
  ensure?: () => Promise<unknown>;
  worktree?: ReviewWorktreeDeps;
} = {}): ReviewCommandDeps {
  return {
    cwd: () => repo,
    findRepoRoot: () => repo,
    currentBranch: () => "main",
    ensureDaemon: options.ensure ?? (async () => undefined),
    api: options.api ?? (async () => ({ status: 500, body: {} })),
    github: {
      run: (command, args) => command === "git"
        ? "git@github.com:Acme/App.git"
        : args[0] === "pr"
          ? ghPayload(options.ghRepo ?? "acme/app", options.ghHead)
          : JSON.stringify({ viewerPermission: options.viewerPermission ?? "WRITE" }),
    },
    worktree: options.worktree,
  };
}

function reviewSession(head = "a".repeat(40)): ReviewRegistrySession {
  const repository = "acme/app" as never;
  return {
    kind: "review",
    id: "otc_review1",
    title: "#42 Typed sessions",
    repo,
    branch: "main",
    quick: false,
    socratic: false,
    status: "reviewing",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    review: {
      pullRequest: {
        identity: { host: "github.com", repository, number: 42, key: "github.com/acme/app#42" },
        url: "https://github.com/acme/app/pull/42",
        title: "Typed sessions",
        author: "octo",
        baseRef: "main",
        headRef: "feature",
        headRepository: repository,
        headSha: head,
        state: "open",
        isCrossRepository: false,
        permissions: { maintainerCanModify: true, viewerPermission: "write", readOnly: false },
      },
      head: { sha: head, ref: "feature", repository, capturedAt: "2026-07-15T00:00:00.000Z" },
      revision: 3,
    },
  };
}

function codeActionThread(
  status: "working" | "completed" | "failed",
  message?: string,
): Record<string, unknown> {
  return {
    id: "t2",
    surface: "review",
    intent: "comment",
    identity: {
      session: "otc_review1",
      reportRevision: 2,
      headRevision: 3,
      headSha: "a".repeat(40),
    },
    codeAction: {
      status,
      requestedAt: "2026-07-15T00:01:00.000Z",
      updatedAt: "2026-07-15T00:02:00.000Z",
      ...(message === undefined ? {} : { message }),
    },
  };
}

function frozenPreparation(head = "a".repeat(40), revision = 4) {
  return {
    revision: {
      version: 1,
      session: "otc_review1",
      revision,
      headRevision: 4,
      headSha: head,
      snapshotHash: "f".repeat(64),
      createdAt: "2026-07-15T00:00:00.000Z",
      status: "prepared",
    },
    snapshot: {
      version: 1,
      session: "otc_review1",
      revision,
      headRevision: 4,
      headSha: head,
      capturedAt: "2026-07-15T00:00:00.000Z",
      hash: "f".repeat(64),
      user: { hash: "a".repeat(64), markdown: "user" },
      project: { repo: "acme/app", hash: "b".repeat(64), markdown: "project" },
    },
    warnings: [],
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

  test("reports an unchanged completed review as read-only instead of returning authoring paths", async () => {
    const session = reviewSession();
    session.status = "done";
    session.review.completions = [{
      version: 1,
      session: session.id,
      completedAt: "2026-07-15T12:00:00.000Z",
      reportRevision: 4,
      headRevision: 3,
      headSha: "a".repeat(40),
      forced: false,
      unresolved: { conversations: 0, quizzes: 0 },
      eventSeq: 7,
      wake: "queued",
    }];
    const printed = await capture(["start", "--pr", "42"], deps({
      api: async () => ({
        status: 200,
        body: { action: "reused-complete", session, preparation: frozenPreparation() },
      }),
    }));
    expect(printed).toMatchObject({ action: "reused-complete", readOnly: true, completion: { eventSeq: 7 } });
    expect(printed.report).toBeUndefined();
    expect(printed.quiz).toBeUndefined();
    expect(printed.knowledge).toBeUndefined();
  });

  test("reopens an active submitted review without asking the agent to overwrite it", async () => {
    const session = reviewSession();
    const preparation = frozenPreparation("a".repeat(40), 4);
    preparation.revision.headRevision = session.review.revision;
    preparation.snapshot.headRevision = session.review.revision;
    (preparation.revision as { status: string }).status = "submitted";
    (preparation.revision as { submittedAt?: string }).submittedAt = "2026-07-15T00:01:00.000Z";
    const printed = await capture(["start", "--pr", "42"], deps({
      api: async () => ({
        status: 200,
        body: { action: "reused", session, preparation },
      }),
    }));
    expect(printed).toMatchObject({ action: "reused", authoring: false });
    expect(printed.report).toBeUndefined();
    expect(printed.quiz).toBeUndefined();
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

describe("review grade", () => {
  const grade = {
    version: 1,
    session: "otc_review1",
    revision: 2,
    headRevision: 3,
    headSha: "a".repeat(40),
    question: "q-open",
    attempt: "qa2",
    verdict: "pass",
    feedback: "You connected the producer and consumer.",
    knowledgeBaseHash: "f".repeat(64),
  };

  test("validates the grade file and preserves question/attempt identity on the wire", async () => {
    const path = join(repo, "grade.json");
    writeFileSync(path, JSON.stringify(grade));
    let wire: unknown;
    const printed = await capture(["grade", "q-open", "--file", path], deps({
      api: async (method, apiPath, body) => {
        expect(method).toBe("POST");
        expect(apiPath).toBe("/api/reviews/otc_review1/quiz/q-open/grade");
        wire = body;
        return { status: 200, body: { repeated: false, attempt: { id: "qa2", status: "pass" }, quiz: { progress: { passed: 1 } } } };
      },
    }));
    expect(wire).toMatchObject({ question: "q-open", attempt: "qa2", knowledgeBaseHash: "f".repeat(64) });
    expect(printed).toMatchObject({ ok: true, session: "otc_review1", question: "q-open", repeated: false });
  });

  test("surfaces a knowledge CAS conflict without treating the attempt as graded", async () => {
    const path = join(repo, "grade.json");
    writeFileSync(path, JSON.stringify(grade));
    let error: CliError | undefined;
    try {
      await reviewCommand(["grade", "q-open", "--file", path], deps({
        api: async () => ({
          status: 409,
          body: { error: { code: "E_KNOWLEDGE_CONFLICT", message: "grade again with current hash" }, currentHash: "e".repeat(64) },
        }),
      }));
    } catch (caught) {
      error = caught as CliError;
    }
    expect(error?.code).toBe("E_KNOWLEDGE_CONFLICT");
    expect(error?.extra.currentHash).toBe("e".repeat(64));
  });

  test("rejects stale question identity and private-schema drift before daemon contact", async () => {
    const path = join(repo, "grade.json");
    writeFileSync(path, JSON.stringify({ ...grade, answerKey: "secret" }));
    let ensured = 0;
    let error: CliError | undefined;
    try {
      await reviewCommand(["grade", "other-question", "--file", path], deps({ ensure: async () => { ensured += 1; } }));
    } catch (caught) {
      error = caught as CliError;
    }
    expect(error?.code).toBe("E_QUIZ_GRADE");
    expect(ensured).toBe(0);
  });
});

describe("review checkout", () => {
  test("refuses before GitHub or worktree access unless one current code action is working", async () => {
    let gitCalls = 0;
    let error: CliError | undefined;
    try {
      await reviewCommand(["checkout", "--session", "otc_review1"], deps({
        worktree: {
          git: () => { gitCalls += 1; return ""; },
          exists: () => false,
          mkdir: () => undefined,
          realpath: (path) => path,
          worktreeDir: () => join(repo, "worktrees"),
          claimLease: () => undefined,
          releaseLease: () => "absent",
        },
        api: async (_method, path) => path.endsWith("/threads")
          ? { status: 200, body: { session: "otc_review1", threads: [] } }
          : { status: 200, body: reviewSession() as unknown as Record<string, unknown> },
      }));
    } catch (caught) {
      error = caught as CliError;
    }
    expect(error?.code).toBe("E_REVIEW_CODE_ACTION");
    expect(error?.message).toContain("marked working");
    expect(gitCalls).toBe(0);
  });

  test("reuses the exact clean worktree and prints the explicit push destination without pushing", async () => {
    const worktree = join(repo, "feature-worktree");
    const head = "a".repeat(40);
    const gitCalls: string[] = [];
    const worktreeDeps: ReviewWorktreeDeps = {
      git: (args, cwd) => {
        gitCalls.push(`${cwd} :: ${args.join(" ")}`);
        const command = args.join(" ");
        if (cwd === repo && command === "remote get-url origin") return "git@github.com:acme/app.git\n";
        if (cwd === repo && command === "check-ref-format --branch feature") return "feature\n";
        if (cwd === repo && command === "worktree list --porcelain -z") {
          return `worktree ${worktree}\0HEAD ${head}\0branch refs/heads/feature\0\0`;
        }
        if (cwd === worktree && command === "symbolic-ref --quiet --short HEAD") return "feature\n";
        if (cwd === worktree && command === "rev-parse --verify HEAD^{commit}") return `${head}\n`;
        if (cwd === worktree && command === "status --porcelain=v1 -z --untracked-files=all") return "";
        throw new Error(`unexpected git call: ${command}`);
      },
      exists: () => false,
      mkdir: () => { throw new Error("reuse must not create a directory"); },
      realpath: (path) => path,
      worktreeDir: () => join(repo, "worktrees"),
      claimLease: () => undefined,
      releaseLease: () => "absent",
    };
    const printed = await capture(["checkout", "--session", "otc_review1"], deps({
      worktree: worktreeDeps,
      api: async (method, path) => {
        expect(method).toBe("GET");
        if (path === "/api/sessions/otc_review1/threads") {
          return { status: 200, body: { session: "otc_review1", threads: [codeActionThread("working")] } };
        }
        expect(path).toBe("/api/sessions/otc_review1");
        return { status: 200, body: reviewSession() as unknown as Record<string, unknown> };
      },
    }));
    expect(printed).toMatchObject({
      ok: true,
      session: "otc_review1",
      mode: "writable",
      action: "reused",
      worktree,
      branch: "feature",
      head,
      push: { remote: "origin", ref: "feature" },
    });
    expect(gitCalls.some((call) => / :: (fetch|reset|checkout|commit|push)( |$)/.test(call))).toBe(false);
  });

  test("fresh GitHub head drift refuses before any worktree git mutation", async () => {
    let gitCalls = 0;
    let error: CliError | undefined;
    try {
      await reviewCommand(["checkout", "--session", "otc_review1"], deps({
        ghHead: "b".repeat(40),
        worktree: {
          git: () => { gitCalls += 1; return ""; },
          exists: () => false,
          mkdir: () => undefined,
          realpath: (path) => path,
          worktreeDir: () => join(repo, "worktrees"),
          claimLease: () => undefined,
          releaseLease: () => "absent",
        },
        api: async (_method, path) => path.endsWith("/threads")
          ? { status: 200, body: { session: "otc_review1", threads: [codeActionThread("working")] } }
          : { status: 200, body: reviewSession() as unknown as Record<string, unknown> },
      }));
    } catch (caught) {
      error = caught as CliError;
    }
    expect(error?.code).toBe("E_REVIEW_HEAD_STALE");
    expect(error?.message).toContain("refresh-head");
    expect(gitCalls).toBe(0);
  });

  test("prints a current permission downgrade as explicit read-only without mutating git", async () => {
    let gitCalls = 0;
    const printed = await capture(["checkout", "--session", "otc_review1"], deps({
      viewerPermission: "READ",
      worktree: {
        git: () => { gitCalls += 1; throw new Error("read-only checkout must not run git"); },
        exists: () => false,
        mkdir: () => { throw new Error("read-only checkout must not create directories"); },
        realpath: (path) => path,
        worktreeDir: () => join(repo, "worktrees"),
        claimLease: () => undefined,
        releaseLease: () => "absent",
      },
      api: async (_method, path) => path.endsWith("/threads")
        ? { status: 200, body: { session: "otc_review1", threads: [codeActionThread("working")] } }
        : { status: 200, body: reviewSession() as unknown as Record<string, unknown> },
    }));
    expect(printed).toMatchObject({
      ok: true,
      session: "otc_review1",
      mode: "read-only",
      action: "read-only",
      reason: "permission",
    });
    expect(gitCalls).toBe(0);
  });
});

describe("review refresh-head", () => {
  test("resolves fresh GitHub metadata, posts only to the known session head route, and returns new authoring paths", async () => {
    const nextHead = "b".repeat(40);
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const updated = reviewSession(nextHead);
    updated.review.revision = 4;
    updated.status = "working";
    const printed = await capture(["refresh-head", "--session", "otc_review1"], deps({
      ghHead: nextHead,
      api: async (method, path, body) => {
        calls.push({ method, path, body });
        if (method === "GET") {
          return { status: 200, body: reviewSession() as unknown as Record<string, unknown> };
        }
        return {
          status: 200,
          body: {
            action: "revised",
            session: updated,
            preparation: frozenPreparation(nextHead),
          },
        };
      },
    }));
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/sessions/otc_review1",
      "POST /api/reviews/otc_review1/head",
    ]);
    expect(calls[1]?.body).toMatchObject({
      pullRequest: { headSha: nextHead, identity: { key: "github.com/acme/app#42" } },
    });
    expect(printed).toMatchObject({
      ok: true,
      action: "revised",
      session: "otc_review1",
      revision: 4,
      headRevision: 4,
      head: nextHead,
      report: expect.stringContaining("/sessions/otc_review1/review.md"),
      quiz: expect.stringContaining("/sessions/otc_review1/quiz.json"),
      knowledge: {
        snapshot: {
          hash: "f".repeat(64),
          user: { path: expect.stringContaining("/review/revisions/r4/user.md") },
          project: { path: expect.stringContaining("/review/revisions/r4/project.md") },
        },
      },
    });
    expect(calls.some(({ path }) => path === "/api/reviews")).toBe(false);
  });

  test("keeps an unchanged completed head read-only without returning authoring paths", async () => {
    const completed = reviewSession();
    completed.status = "done";
    completed.review.completions = [{
      version: 1,
      session: completed.id,
      completedAt: "2026-07-15T12:00:00.000Z",
      reportRevision: 4,
      headRevision: 3,
      headSha: "a".repeat(40),
      forced: false,
      unresolved: { conversations: 0, quizzes: 0 },
      eventSeq: 7,
      wake: "queued",
    }];
    const printed = await capture(["refresh-head", "--session", completed.id], deps({
      api: async (method) => method === "GET"
        ? { status: 200, body: completed as unknown as Record<string, unknown> }
        : {
          status: 200,
          body: { action: "reused-complete", session: completed, preparation: frozenPreparation() },
        },
    }));
    expect(printed).toMatchObject({ action: "reused-complete", readOnly: true, completion: { eventSeq: 7 } });
    expect(printed.report).toBeUndefined();
    expect(printed.quiz).toBeUndefined();
    expect(printed.knowledge).toBeUndefined();
  });

  test("requires an explicit review session before contacting the daemon", async () => {
    let ensured = 0;
    let error: CliError | undefined;
    try {
      await reviewCommand(["refresh-head"], deps({ ensure: async () => { ensured += 1; } }));
    } catch (caught) {
      error = caught as CliError;
    }
    expect(error?.code).toBe("E_USAGE");
    expect(ensured).toBe(0);
  });
});

describe("review revise", () => {
  const submitted = (revision: number, headRevision = 3, head = "a".repeat(40)) => ({
    revision: {
      version: 1,
      session: "otc_review1",
      revision,
      headRevision,
      headSha: head,
      snapshotHash: "f".repeat(64),
      createdAt: "2026-07-15T00:00:00.000Z",
      submittedAt: "2026-07-15T00:01:00.000Z",
      status: "submitted",
    },
    snapshot: {
      version: 1,
      session: "otc_review1",
      revision,
      headRevision,
      headSha: head,
      capturedAt: "2026-07-15T00:00:00.000Z",
      hash: "f".repeat(64),
      user: { hash: "a".repeat(64), markdown: "user" },
      project: { repo: "acme/app", hash: "b".repeat(64), markdown: "project" },
    },
    warnings: [],
  });

  test("preflights the current submitted head and prints a new frozen preparation", async () => {
    const calls: string[] = [];
    const current = submitted(4);
    const next = submitted(5);
    next.revision.status = "prepared";
    delete (next.revision as { submittedAt?: string }).submittedAt;
    next.snapshot.hash = "e".repeat(64);
    next.revision.snapshotHash = next.snapshot.hash;
    const printed = await capture(["revise", "--session", "otc_review1"], deps({
      api: async (method, path, body) => {
        calls.push(`${method} ${path}`);
        if (path === "/api/sessions/otc_review1") return { status: 200, body: reviewSession() as unknown as Record<string, unknown> };
        if (method === "GET") return { status: 200, body: { session: reviewSession(), report: current, preparation: current } };
        expect(body).toEqual({
          source: {
            reportRevision: 4,
            headRevision: 3,
            headSha: "a".repeat(40),
          },
        });
        return { status: 201, body: { preparation: next } };
      },
    }));
    expect(calls).toEqual([
      "GET /api/sessions/otc_review1",
      "GET /api/reviews/otc_review1",
      "POST /api/reviews/otc_review1/revisions",
    ]);
    expect(printed).toMatchObject({
      ok: true,
      session: "otc_review1",
      revision: 5,
      headRevision: 3,
      head: "a".repeat(40),
      report: expect.stringContaining("/sessions/otc_review1/review.md"),
      quiz: expect.stringContaining("/sessions/otc_review1/quiz.json"),
      knowledge: { snapshot: { hash: "e".repeat(64) } },
    });
  });

  test("reuses an already-prepared revision instead of refusing the retry", async () => {
    const calls: string[] = [];
    const current = submitted(4);
    const prepared = submitted(5);
    prepared.revision.status = "prepared";
    delete (prepared.revision as { submittedAt?: string }).submittedAt;
    prepared.snapshot.hash = "e".repeat(64);
    prepared.revision.snapshotHash = prepared.snapshot.hash;
    const printed = await capture(["revise", "--session", "otc_review1"], deps({
      api: async (method, path) => {
        calls.push(`${method} ${path}`);
        if (path === "/api/sessions/otc_review1") return { status: 200, body: reviewSession() as unknown as Record<string, unknown> };
        return { status: 200, body: { session: reviewSession(), report: current, preparation: prepared } };
      },
    }));
    // No POST: the interrupted retry resumes the existing preparation.
    expect(calls).toEqual([
      "GET /api/sessions/otc_review1",
      "GET /api/reviews/otc_review1",
    ]);
    expect(printed).toMatchObject({
      ok: true,
      session: "otc_review1",
      revision: 5,
      headRevision: 3,
      head: "a".repeat(40),
      knowledge: { snapshot: { hash: "e".repeat(64) } },
    });
  });

  test("refuses a stale submitted report before creating a revision", async () => {
    let posts = 0;
    let error: CliError | undefined;
    try {
      await reviewCommand(["revise", "--session", "otc_review1"], deps({
        api: async (method, path) => {
          if (method === "POST") posts += 1;
          if (path === "/api/sessions/otc_review1") return { status: 200, body: reviewSession() as unknown as Record<string, unknown> };
          const stale = submitted(4, 2, "b".repeat(40));
          return { status: 200, body: { session: reviewSession(), report: stale, preparation: stale } };
        },
      }));
    } catch (caught) {
      error = caught as CliError;
    }
    expect(error?.code).toBe("E_REVIEW_REVISION_STALE");
    expect(posts).toBe(0);
  });
});

describe("review thread agent commands", () => {
  const source = { reportRevision: 2, headRevision: 3, headSha: "a".repeat(40) };

  test("respond validates identity, posts the exact response, and prints the thread", async () => {
    const file = join(repo, "response.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      session: "otc_review1",
      thread: "t2",
      source,
      body: "Clarified in the replacement report.",
      responseReportRevision: 3,
      saved: { scope: "project", updated: true },
    }));
    let request: { path: string; body?: unknown } | undefined;
    const printed = await capture(["respond", "t2", "--file", file], deps({
      api: async (_method, path, body) => {
        request = { path, body };
        return { status: 200, body: { thread: { id: "t2", response: { body: "Clarified in the replacement report." } } } };
      },
    }));
    expect(request).toEqual({
      path: "/api/reviews/otc_review1/threads/t2/respond",
      body: {
        source,
        body: "Clarified in the replacement report.",
        responseReportRevision: 3,
        saved: { scope: "project", updated: true },
      },
    });
    expect(printed).toMatchObject({ ok: true, session: "otc_review1", thread: { id: "t2" } });
  });

  test("code-status posts only a typed lifecycle transition", async () => {
    const file = join(repo, "code-status.json");
    writeFileSync(file, JSON.stringify({
      version: 1, session: "otc_review1", thread: "t2", source,
      status: "completed", message: "Verified and pushed.",
    }));
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    let releases = 0;
    await capture(["code-status", "t2", "--file", file], deps({
      worktree: {
        git: () => "",
        exists: () => false,
        mkdir: () => undefined,
        realpath: (path) => path,
        worktreeDir: () => join(repo, "worktrees"),
        claimLease: () => undefined,
        releaseLease: () => { releases += 1; return "released"; },
      },
      api: async (method, path, body) => {
        requests.push({ method, path, body });
        if (method === "GET") {
          return { status: 200, body: reviewSession() as unknown as Record<string, unknown> };
        }
        return { status: 200, body: { thread: codeActionThread("completed", "Verified and pushed.") } };
      },
    }));
    expect(requests).toEqual([
      { method: "GET", path: "/api/sessions/otc_review1", body: undefined },
      {
        method: "POST",
        path: "/api/reviews/otc_review1/threads/t2/code-action/status",
        body: { source, status: "completed", message: "Verified and pushed." },
      },
    ]);
    expect(releases).toBe(1);
  });

  test("failed code-status also releases the lease after the durable transition", async () => {
    const file = join(repo, "code-failed.json");
    writeFileSync(file, JSON.stringify({
      version: 1, session: "otc_review1", thread: "t2", source,
      status: "failed", message: "Implementation agent crashed.",
    }));
    let released = 0;
    await capture(["code-status", "t2", "--file", file], deps({
      worktree: {
        git: () => "",
        exists: () => false,
        mkdir: () => undefined,
        realpath: (path) => path,
        worktreeDir: () => join(repo, "worktrees"),
        claimLease: () => undefined,
        releaseLease: () => { released += 1; return "released"; },
      },
      api: async (method) => method === "GET"
        ? { status: 200, body: reviewSession() as unknown as Record<string, unknown> }
        : { status: 200, body: { repeated: true, thread: codeActionThread("failed", "Implementation agent crashed.") } },
    }));
    expect(released).toBe(1);
  });

  test("strict files reject mismatched thread ids, unknown keys, and false memory claims before daemon contact", async () => {
    const cases = [
      { version: 1, session: "otc_review1", thread: "t9", source, body: "answer" },
      { version: 1, session: "otc_review1", thread: "t2", source, body: "answer", surprise: true },
      { version: 1, session: "otc_review1", thread: "t2", source, body: "answer", saved: { scope: "project", updated: false } },
    ];
    let calls = 0;
    for (const [index, value] of cases.entries()) {
      const file = join(repo, `bad-${index}.json`);
      writeFileSync(file, JSON.stringify(value));
      await expect(reviewCommand(["respond", "t2", "--file", file], deps({
        ensure: async () => { calls += 1; },
      }))).rejects.toBeInstanceOf(CliError);
    }
    expect(calls).toBe(0);
  });

  test("typed daemon conflicts pass through without being collapsed", async () => {
    const file = join(repo, "conflict.json");
    writeFileSync(file, JSON.stringify({ version: 1, session: "otc_review1", thread: "q1", source, body: "answer" }));
    let error: CliError | undefined;
    try {
      await reviewCommand(["respond", "q1", "--file", file], deps({
        api: async () => ({ status: 409, body: { error: { code: "E_REVIEW_THREAD_STALE", message: "stale" } } }),
      }));
    } catch (caught) {
      error = caught as CliError;
    }
    expect(error?.code).toBe("E_REVIEW_THREAD_STALE");
  });
});
