// resume end-to-end against a fake daemon (the implement-done.test.ts harness):
// a loopback server answers /api/health (version-matched so ensureDaemon
// fast-paths), GET /api/sessions (the registry the resolver reads), and POST
// /api/sessions/:id/reopen. We assert the worktree auto-detection branching, the
// enriched JSON it prints (title/repo/plan added to the daemon's reopen body),
// and that a 409 surfaces as CliError, not a crash.
//
// cwd auto-detection rides on a tmp dir that is NOT a git repo: findRepoRoot
// returns undefined so the resolver falls back to realpathOr(cwd), letting that
// dir stand in as the recorded build worktree without a real checkout.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPath } from "../../shared/paths.js";
import { VERSION } from "../../shared/version.js";
import { CliError } from "../output.js";
import { resumeCommand } from "./resume.js";

let server: Server | undefined;
let savedPort: string | undefined;
let savedHome: string | undefined;
let savedCwd: string;
let worktree: string;

interface Fake {
  /** The registry the fake daemon serves on GET /api/sessions. */
  sessions: unknown[];
  /** status + JSON the daemon returns for POST /reopen. */
  reply: { status: number; body: unknown };
  /** Filled in by the handler when /reopen is POSTed. */
  reopenPath?: string;
}

async function listen(fake: Fake): Promise<void> {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") {
      return void res.end(JSON.stringify({ app: "otacond", version: VERSION, pid: 99999 }));
    }
    if (req.method === "GET" && req.url === "/api/sessions") {
      return void res.end(JSON.stringify({ sessions: fake.sessions }));
    }
    if (req.method === "POST" && req.url?.endsWith("/reopen")) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        fake.reopenPath = req.url ?? undefined;
        res.statusCode = fake.reply.status;
        res.end(JSON.stringify(fake.reply.body));
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  };
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.OTACON_PORT = String(port);
}

/** Run the command, capturing the single JSON line it prints to stdout. */
async function run(argv: string[]): Promise<{ code: number; printed: unknown }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let printed: unknown;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    printed = JSON.parse(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await resumeCommand(argv);
    return { code, printed };
  } finally {
    process.stdout.write = originalWrite;
  }
}

beforeEach(() => {
  savedPort = process.env.OTACON_PORT;
  savedHome = process.env.OTACON_HOME;
  savedCwd = process.cwd();
  // A non-git tmp dir standing in as the recorded Implement build worktree.
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "otacon-resume-wt-")));
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
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
});

const MAIN_REPO = "/main/repo";
const SESSION_ID = "otc_resume1";

function owner(id: string, status = "implemented") {
  return { id, title: `t-${id}`, repo: MAIN_REPO, branch: "", status, impl: { worktree, branch: "feat" } };
}

test("auto-detects the worktree owner and prints the enriched reopen body", async () => {
  const fake: Fake = {
    sessions: [owner(SESSION_ID), { id: "otc_other", repo: "/elsewhere", status: "implementing" }],
    reply: {
      status: 200,
      body: { ok: true, session: SESSION_ID, status: "revising", revision: 3, impl: { worktree, branch: "feat" } },
    },
  };
  await listen(fake);

  const { code, printed } = await run([]);

  expect(code).toBe(0);
  expect(fake.reopenPath).toBe(`/api/sessions/${SESSION_ID}/reopen`);
  // The daemon body is spread through, plus title/repo/plan so the agent knows
  // where the plan to amend lives (under the MAIN repo, not this worktree).
  expect(printed).toEqual({
    ok: true,
    session: SESSION_ID,
    status: "revising",
    revision: 3,
    impl: { worktree, branch: "feat" },
    title: `t-${SESSION_ID}`,
    repo: MAIN_REPO,
    plan: planPath(SESSION_ID),
  });
});

test("--session targets a session by id, bypassing cwd detection", async () => {
  const fake: Fake = {
    // No owner of this worktree: only an explicit id can reach it.
    sessions: [{ id: SESSION_ID, title: "t", repo: MAIN_REPO, branch: "", status: "approved" }],
    reply: { status: 200, body: { ok: true, session: SESSION_ID, status: "revising", revision: 1 } },
  };
  await listen(fake);

  const { code, printed } = await run(["--session", SESSION_ID]);

  expect(code).toBe(0);
  expect(fake.reopenPath).toBe(`/api/sessions/${SESSION_ID}/reopen`);
  expect((printed as { plan: string }).plan).toBe(planPath(SESSION_ID));
});

test("--session not in the registry refuses E_UNKNOWN_SESSION before any POST", async () => {
  const fake: Fake = { sessions: [owner(SESSION_ID)], reply: { status: 200, body: {} } };
  await listen(fake);

  let thrown: unknown;
  try {
    await run(["--session", "otc_nope"]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CliError);
  expect((thrown as CliError).code).toBe("E_UNKNOWN_SESSION");
  expect(fake.reopenPath).toBeUndefined();
});

test("no worktree owner refuses E_NO_RESUME_CANDIDATE", async () => {
  const fake: Fake = {
    sessions: [{ id: SESSION_ID, repo: MAIN_REPO, status: "implemented", impl: { worktree: "/other/wt", branch: "x" } }],
    reply: { status: 200, body: {} },
  };
  await listen(fake);

  let thrown: unknown;
  try {
    await run([]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CliError);
  expect((thrown as CliError).code).toBe("E_NO_RESUME_CANDIDATE");
  expect(fake.reopenPath).toBeUndefined();
});

test("two owners of the same worktree refuse E_AMBIGUOUS_RESUME with the candidate list", async () => {
  const fake: Fake = {
    sessions: [owner("otc_one"), owner("otc_two")],
    reply: { status: 200, body: {} },
  };
  await listen(fake);

  let thrown: unknown;
  try {
    await run([]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CliError);
  const err = thrown as CliError;
  expect(err.code).toBe("E_AMBIGUOUS_RESUME");
  expect(err.extra.sessions).toEqual([
    { id: "otc_one", title: "t-otc_one", status: "implemented" },
    { id: "otc_two", title: "t-otc_two", status: "implemented" },
  ]);
  expect(fake.reopenPath).toBeUndefined();
});

test("a 409 from /reopen surfaces the daemon's E_NOT_REOPENABLE as a CliError", async () => {
  const fake: Fake = {
    sessions: [owner(SESSION_ID, "approved")],
    reply: {
      status: 409,
      body: { error: { code: "E_NOT_REOPENABLE", message: `session ${SESSION_ID} is approved, not reopenable` } },
    },
  };
  await listen(fake);

  let thrown: unknown;
  try {
    await run([]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CliError);
  expect((thrown as CliError).code).toBe("E_NOT_REOPENABLE");
  expect((thrown as CliError).exitCode).toBe(1);
});

test("a 404 from /reopen surfaces E_UNKNOWN_SESSION", async () => {
  const fake: Fake = {
    sessions: [owner(SESSION_ID)],
    reply: { status: 404, body: { error: { code: "E_NOT_FOUND", message: "gone" } } },
  };
  await listen(fake);

  let thrown: unknown;
  try {
    await run([]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CliError);
  expect((thrown as CliError).code).toBe("E_UNKNOWN_SESSION");
});
