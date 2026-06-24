// status end-to-end against a fake daemon (the implement-done.test.ts harness):
// a loopback server answers /api/health (version-matched), GET /api/sessions
// (the index), and GET /api/sessions/:id (the detail). Focus: `resumeCandidate`
// surfaces when cwd is inside a known build worktree.
//
// cwd rides on a non-git tmp dir standing in as the recorded build worktree:
// findRepoRoot returns undefined, so worktreeOwners falls back to realpathOr(cwd)
// and matches the session's recorded impl.worktree. The owner's `.repo` is the
// MAIN repo, which does NOT contain cwd, so it never appears in `sessions`.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPath } from "../../shared/paths.js";
import { VERSION } from "../../shared/version.js";
import { statusCommand } from "./status.js";

let server: Server | undefined;
let savedPort: string | undefined;
let savedCwd: string;
let worktree: string;

interface Fake {
  /** The index the daemon serves on GET /api/sessions. */
  index: Array<Record<string, unknown>>;
  /** Per-id detail bodies; defaults to the index entry when absent. */
  detail?: Record<string, Record<string, unknown>>;
}

async function listen(fake: Fake): Promise<void> {
  const byId = new Map(fake.index.map((s) => [s.id as string, s]));
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") {
      return void res.end(JSON.stringify({ app: "otacond", version: VERSION, pid: 99999 }));
    }
    if (req.method === "GET" && req.url === "/api/sessions") {
      return void res.end(JSON.stringify({ sessions: fake.index }));
    }
    const m = req.method === "GET" && req.url?.match(/^\/api\/sessions\/([^/]+)$/);
    if (m) {
      const id = m[1] as string;
      const body = fake.detail?.[id] ?? byId.get(id);
      if (body === undefined) {
        res.statusCode = 404;
        return void res.end("{}");
      }
      return void res.end(JSON.stringify(body));
    }
    res.statusCode = 404;
    res.end("{}");
  };
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.OTACON_PORT = String(port);
}

async function run(argv: string[]): Promise<{ code: number; printed: Record<string, unknown> }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let printed: Record<string, unknown> = {};
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    printed = JSON.parse(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await statusCommand(argv);
    return { code, printed };
  } finally {
    process.stdout.write = originalWrite;
  }
}

beforeEach(() => {
  savedPort = process.env.OTACON_PORT;
  savedCwd = process.cwd();
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "otacon-status-wt-")));
  process.chdir(worktree);
});

afterEach(async () => {
  process.chdir(savedCwd);
  rmSync(worktree, { recursive: true, force: true });
  const closing = server;
  server = undefined;
  if (closing) {
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  if (savedPort === undefined) delete process.env.OTACON_PORT;
  else process.env.OTACON_PORT = savedPort;
});

const MAIN_REPO = "/main/repo";

test("surfaces a resumeCandidate when cwd is the recorded build worktree", async () => {
  const id = "otc_status1";
  const fake: Fake = {
    index: [
      // Owner's repo is the MAIN repo (does not contain cwd) → not in `sessions`.
      { id, title: "amend me", repo: MAIN_REPO, status: "implemented", impl: { worktree, branch: "feat" } },
    ],
  };
  await listen(fake);

  const { code, printed } = await run([]);

  expect(code).toBe(0);
  // The owner's repo does not contain cwd, so the repo-scoped list is empty...
  expect(printed.sessions).toEqual([]);
  // ...but the worktree owner surfaces as the resume candidate.
  expect(printed.resumeCandidate).toEqual({
    id,
    title: "amend me",
    status: "implemented",
    plan: planPath(id),
  });
});

test("omits resumeCandidate when cwd is not inside any known build worktree", async () => {
  const fake: Fake = {
    index: [{ id: "otc_x", title: "t", repo: "/elsewhere", status: "implemented", impl: { worktree: "/other/wt", branch: "x" } }],
  };
  await listen(fake);

  const { code, printed } = await run([]);

  expect(code).toBe(0);
  expect(printed.resumeCandidate).toBeUndefined();
  expect("resumeCandidate" in printed).toBe(false);
});
