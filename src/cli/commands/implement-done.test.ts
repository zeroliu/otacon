// implement-done end-to-end against a fake daemon (the client.test.ts harness):
// a loopback server answers /api/health (version-matched so ensureDaemon
// fast-paths), GET /api/sessions (the registry the resolver reads), and POST
// /api/sessions/:id/implement-done. We assert the POST body the command sends,
// the JSON it prints, and that daemon errors surface as CliError, not a crash.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { VERSION } from "../../shared/version.js";
import { CliError } from "../output.js";
import { implementDoneCommand } from "./implement-done.js";

let server: Server | undefined;
let savedPort: string | undefined;
let savedHome: string | undefined;

// What the fake daemon does for the implement-done POST, and what it captured.
interface Fake {
  /** status + JSON the daemon returns for POST /implement-done. */
  reply: { status: number; body: unknown };
  /** The repo path the single registry session reports (defaults to cwd). */
  repo: string;
  /** Filled in by the handler when implement-done is POSTed. */
  body?: Record<string, unknown>;
  path?: string;
}

const SESSION_ID = "otc_impl01";

async function listen(fake: Fake): Promise<void> {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") {
      return void res.end(JSON.stringify({ app: "otacond", version: VERSION, pid: 99999 }));
    }
    if (req.method === "GET" && req.url === "/api/sessions") {
      return void res.end(
        JSON.stringify({
          sessions: [{ id: SESSION_ID, title: "t", repo: fake.repo, branch: "", status: "implementing" }],
        }),
      );
    }
    if (req.method === "POST" && req.url?.endsWith("/implement-done")) {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        fake.path = req.url ?? undefined;
        fake.body = raw === "" ? {} : JSON.parse(raw);
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
    const code = await implementDoneCommand(argv);
    return { code, printed };
  } finally {
    process.stdout.write = originalWrite;
  }
}

beforeEach(() => {
  savedPort = process.env.OTACON_PORT;
  savedHome = process.env.OTACON_HOME;
});

afterEach(async () => {
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

test("--pr reports a PR and prints the daemon's implemented outcome", async () => {
  const session = {
    id: SESSION_ID,
    status: "implemented",
    prUrl: "https://example.test/pr/7",
  };
  const fake: Fake = {
    repo: process.cwd(),
    reply: { status: 200, body: { ok: true, session, status: "implemented", prUrl: session.prUrl } },
  };
  await listen(fake);

  const { code, printed } = await run(["--pr", "https://example.test/pr/7", "--session", SESSION_ID]);

  expect(code).toBe(0);
  // The POST carries exactly the PR; no `failed` key when the flag is absent.
  expect(fake.body).toEqual({ pr: "https://example.test/pr/7" });
  expect(fake.path).toBe(`/api/sessions/${SESSION_ID}/implement-done`);
  // It prints the daemon's response verbatim — the {ok, session, status, prUrl} shape.
  expect(printed).toEqual({ ok: true, session, status: "implemented", prUrl: "https://example.test/pr/7" });
});

test("--failed reports the failure and prints implement_failed", async () => {
  const fake: Fake = {
    repo: process.cwd(),
    reply: {
      status: 200,
      body: { ok: true, session: { id: SESSION_ID, status: "implement_failed" }, status: "implement_failed" },
    },
  };
  await listen(fake);

  const { code, printed } = await run(["--failed", "--session", SESSION_ID]);

  expect(code).toBe(0);
  // Only `failed:true` travels; no `pr` key when --pr is absent.
  expect(fake.body).toEqual({ failed: true });
  expect((printed as { status: string }).status).toBe("implement_failed");
});

test("a 409 E_NOT_IMPLEMENTING surfaces as a CliError, not a crash", async () => {
  const fake: Fake = {
    repo: process.cwd(),
    reply: {
      status: 409,
      body: { error: { code: "E_NOT_IMPLEMENTING", message: `session ${SESSION_ID} is not implementing` } },
    },
  };
  await listen(fake);

  let thrown: unknown;
  try {
    await run(["--session", SESSION_ID]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CliError);
  expect((thrown as CliError).code).toBe("E_NOT_IMPLEMENTING");
  expect((thrown as CliError).exitCode).toBe(1);
  // A bare report (no flags) still posts {} — the daemon defaults to implemented.
  expect(fake.body).toEqual({});
});

test("no active session for the repo refuses E_NO_SESSION (no --session, foreign repo)", async () => {
  // The registry's only session lives in a different repo, so cwd has none.
  const fake: Fake = {
    repo: "/somewhere/else/entirely",
    reply: { status: 200, body: { ok: true } },
  };
  await listen(fake);

  let thrown: unknown;
  try {
    await run([]);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CliError);
  expect((thrown as CliError).code).toBe("E_NO_SESSION");
  // Resolution failed before any POST — the daemon never saw implement-done.
  expect(fake.body).toBeUndefined();
});
