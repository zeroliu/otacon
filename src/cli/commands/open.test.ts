// open end-to-end against a fake daemon (the status.test.ts harness): a loopback
// server answers /api/health (version-matched, with a `viewers` count we vary per
// test) and GET /api/sessions (the index). Focus: open-tab reuse — `viewers >= 1`
// suppresses a new launch (DECISIONS.md "reuse an existing open tab").
//
// OTACON_NO_BROWSER=1 throughout, so no real browser launches and the JSON line
// on stdout is the observable result: `reused: false` is the spawn-or-print path,
// `reused: true` is the dedup path that did NOT open another tab. cwd rides on a
// non-git tmp dir so an explicit --session resolves regardless of where the test
// process happens to run from.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../../shared/version.js";
import { openCommand } from "./open.js";

let server: Server | undefined;
let savedPort: string | undefined;
let savedNoBrowser: string | undefined;
let savedCwd: string;
let cwd: string;
let navigateBodies: unknown[];

interface Fake {
  /** Live SSE viewers reported on /api/health (open-tab reuse signal). */
  viewers: number;
  /** The index the daemon serves on GET /api/sessions. */
  index: Array<Record<string, unknown>>;
  /** Whether the daemon reports that it routed an existing tab. */
  navigateDelivered?: boolean;
}

async function listen(fake: Fake): Promise<void> {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") {
      return void res.end(
        JSON.stringify({ app: "otacond", version: VERSION, pid: 99999, viewers: fake.viewers }),
      );
    }
    if (req.method === "GET" && req.url === "/api/sessions") {
      return void res.end(JSON.stringify({ sessions: fake.index }));
    }
    if (req.method === "POST" && req.url === "/api/viewers/navigate") {
      let raw = "";
      req.on("data", (chunk) => (raw += String(chunk)));
      req.on("end", () => {
        navigateBodies.push(JSON.parse(raw));
        res.end(JSON.stringify({ ok: true, delivered: fake.navigateDelivered === true, path: "/" }));
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

async function run(argv: string[]): Promise<{ code: number; printed: Record<string, unknown> | undefined }> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let printed: Record<string, unknown> | undefined;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    printed = JSON.parse(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await openCommand(argv);
    return { code, printed };
  } finally {
    process.stdout.write = originalWrite;
  }
}

beforeEach(() => {
  savedPort = process.env.OTACON_PORT;
  savedNoBrowser = process.env.OTACON_NO_BROWSER;
  savedCwd = process.cwd();
  process.env.OTACON_NO_BROWSER = "1";
  navigateBodies = [];
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "otacon-open-")));
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
  if (savedNoBrowser === undefined) delete process.env.OTACON_NO_BROWSER;
  else process.env.OTACON_NO_BROWSER = savedNoBrowser;
});

const session = (id: string) => ({ id, title: `t-${id}`, repo: "/elsewhere", status: "review" });

test("viewers: 0 opens the session url with reused: false", async () => {
  const id = "otc_open1";
  await listen({ viewers: 0, index: [session(id)] });

  const { code, printed } = await run(["--session", id]);

  expect(code).toBe(0);
  expect(printed?.reused).toBe(false);
  expect(printed?.session).toBe(id);
  expect(printed?.url).toBe(`http://127.0.0.1:${process.env.OTACON_PORT}/s/${id}`);
});

test("viewers: 2 dedups: same url, reused: true, no spawn", async () => {
  const id = "otc_open2";
  await listen({ viewers: 2, index: [session(id)] });

  const { code, printed } = await run(["--session", id]);

  expect(code).toBe(0);
  expect(printed?.reused).toBe(true);
  expect(printed?.session).toBe(id);
  expect(printed?.url).toBe(`http://127.0.0.1:${process.env.OTACON_PORT}/s/${id}`);
  expect(navigateBodies).toEqual([]); // headless mode has no browser side effects
});

test("interactive open routes one existing tab to the exact session", async () => {
  const id = "otc_routed";
  await listen({ viewers: 2, index: [session(id)], navigateDelivered: true });
  delete process.env.OTACON_NO_BROWSER;

  const { code, printed } = await run(["--session", id]);

  expect(code).toBe(0);
  expect(printed).toBeUndefined();
  expect(navigateBodies).toEqual([{ session: id }]);
});

test("index fallback dedups too when viewers >= 1", async () => {
  // No session resolves for cwd (empty index), so open degrades to the index
  // url; an already-open tab still suppresses the launch.
  await listen({ viewers: 1, index: [] });

  const { code, printed } = await run([]);

  expect(code).toBe(0);
  expect(printed?.reused).toBe(true);
  expect(printed?.url).toBe(`http://127.0.0.1:${process.env.OTACON_PORT}/`);
  expect("session" in (printed ?? {})).toBe(false);
});

test("index fallback opens (reused: false) when no tab is connected", async () => {
  await listen({ viewers: 0, index: [] });

  const { code, printed } = await run([]);

  expect(code).toBe(0);
  expect(printed?.reused).toBe(false);
  expect(printed?.url).toBe(`http://127.0.0.1:${process.env.OTACON_PORT}/`);
});
