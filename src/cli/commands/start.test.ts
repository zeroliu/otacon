// start end-to-end against a fake daemon (the status.test.ts harness): a
// loopback server answers /api/health (version-matched, so ensureDaemon never
// spawns) and POST /api/sessions (mint). Focus: the printed JSON carries the
// `plan` draft path, resolved under the home store, so the agent knows where to
// write plan.md after the relocation (DECISIONS.md "Session working state lives
// in the home store").

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPath } from "../../shared/paths.js";
import { VERSION } from "../../shared/version.js";
import { startCommand } from "./start.js";

let server: Server | undefined;
let savedPort: string | undefined;
let savedCwd: string;
let cwd: string;
// The last parsed POST /api/sessions body, so a test can assert the exact wire
// shape the CLI sent (e.g. that `socratic` is omitted unless `--socratic`).
let lastBody: Record<string, unknown> = {};

async function listen(): Promise<void> {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") {
      return void res.end(JSON.stringify({ app: "otacond", version: VERSION, pid: 99999 }));
    }
    if (req.method === "POST" && req.url === "/api/sessions") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const input = JSON.parse(raw || "{}") as Record<string, unknown>;
        lastBody = input;
        const now = "2026-06-24T00:00:00.000Z";
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            id: "otc_start1",
            title: input.title,
            repo: input.repo,
            branch: input.branch ?? "",
            quick: input.quick ?? false,
            // The real daemon resolves an omitted socratic from config; the fake
            // mirrors the explicit-wins half so we can assert the CLI's wire shape.
            socratic: input.socratic ?? false,
            status: "draft",
            createdAt: now,
            updatedAt: now,
          }),
        );
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

async function run(argv: string[]): Promise<{ code: number; printed: Record<string, unknown> }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let printed: Record<string, unknown> = {};
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    printed = JSON.parse(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await startCommand(argv);
    return { code, printed };
  } finally {
    process.stdout.write = originalWrite;
  }
}

beforeEach(() => {
  lastBody = {};
  savedPort = process.env.OTACON_PORT;
  savedCwd = process.cwd();
  // A non-git tmp dir so findRepoRoot falls back to cwd (no git calls).
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "otacon-start-")));
  process.chdir(cwd);
});

afterEach(async () => {
  process.chdir(savedCwd);
  rmSync(cwd, { recursive: true, force: true });
  const closing = server;
  server = undefined;
  if (closing) {
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  if (savedPort === undefined) delete process.env.OTACON_PORT;
  else process.env.OTACON_PORT = savedPort;
});

test("start prints the home plan draft path", async () => {
  await listen();

  const { code, printed } = await run(["--title", "relocate-state"]);

  expect(code).toBe(0);
  expect(printed.session).toBe("otc_start1");
  // The plan path resolves under the home store, not <repo>/.otacon/<id>/.
  expect(printed.plan).toBe(planPath("otc_start1"));
  expect(String(printed.plan)).toContain("/sessions/otc_start1/plan.md");
  expect(String(printed.plan)).not.toContain("/.otacon/otc_start1/");
});

test("--socratic sends socratic:true and echoes it in the printed JSON", async () => {
  await listen();

  const { code, printed } = await run(["--title", "grill-me", "--socratic"]);

  expect(code).toBe(0);
  expect(lastBody.socratic).toBe(true);
  expect(printed.socratic).toBe(true);
});

test("a plain start omits socratic from the wire body (config default applies)", async () => {
  await listen();

  const { code, printed } = await run(["--title", "plain"]);

  expect(code).toBe(0);
  // Omitted on the wire — the daemon applies socratic.default, not a forced false.
  expect("socratic" in lastBody).toBe(false);
  // The fake daemon defaults to false, which the CLI echoes back verbatim.
  expect(printed.socratic).toBe(false);
});

test("--prompt forwards the trimmed verbatim request in the wire body", async () => {
  await listen();

  const { code } = await run(["--title", "capture", "--prompt", "  build me a widget  "]);

  expect(code).toBe(0);
  expect(lastBody.prompt).toBe("build me a widget");
});

test("a whitespace-only --prompt omits prompt from the wire body", async () => {
  await listen();

  const { code } = await run(["--title", "blank", "--prompt", "   "]);

  expect(code).toBe(0);
  expect("prompt" in lastBody).toBe(false);
});
