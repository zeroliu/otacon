import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
    expect(printed.knowledge).toEqual(expect.objectContaining({
      user: expect.stringContaining("/knowledge/user.md"),
      project: expect.stringContaining("/knowledge/projects/github.com/acme/app/knowledge.md"),
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
