// ensureDaemon's restart state machine (DESIGN.md §16; DECISIONS.md
// "Stale-daemon restart") against fake HTTP daemons: the fast path, the
// foreign-port refusal, the probe→shutdown TOCTOU re-check (a daemon already
// current by shutdown time is spared), a peer's respawn being adopted, and a
// genuine stale restart that spawns a real otacond.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../shared/version.js";
import { ensureDaemon } from "./client.js";
import { CliError } from "./output.js";

let home: string;
let savedHome: string | undefined;
let savedPort: string | undefined;
let server: Server | undefined;

beforeEach(() => {
  savedHome = process.env.OTACON_HOME;
  savedPort = process.env.OTACON_PORT;
  home = mkdtempSync(join(tmpdir(), "otacon-client-"));
  process.env.OTACON_HOME = home;
});

afterEach(async () => {
  await closeServer();
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
  if (savedPort === undefined) delete process.env.OTACON_PORT;
  else process.env.OTACON_PORT = savedPort;
  rmSync(home, { recursive: true, force: true });
});

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Fake daemon on an ephemeral port; points OTACON_PORT at it. */
async function listen(handler: Handler): Promise<void> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.OTACON_PORT = String(port);
}

function closeServer(): Promise<void> {
  const closing = server;
  server = undefined;
  if (!closing) return Promise.resolve();
  closing.closeAllConnections();
  return new Promise((resolve) => closing.close(() => resolve()));
}

const health = (version: string) =>
  JSON.stringify({ app: "otacond", version, pid: 99999 });

const expectCliError = async (promise: Promise<unknown>, code: string): Promise<void> => {
  try {
    await promise;
    throw new Error(`expected CliError ${code}, got success`);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(code);
  }
};

test("fast path: an up-to-date daemon is returned without any shutdown", async () => {
  let shutdowns = 0;
  await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") return void res.end(health(VERSION));
    if (req.method === "POST" && req.url === "/api/shutdown") {
      shutdowns++;
      return void res.end('{"ok":true}');
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const result = await ensureDaemon();
  expect(result.version).toBe(VERSION);
  expect(result.app).toBe("otacond");
  expect(shutdowns).toBe(0);
});

test("a port owned by something that is not otacond is refused", async () => {
  await listen((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end('{"hello":"world"}');
  });
  await expectCliError(ensureDaemon(), "E_PORT_CONFLICT");
});

test("TOCTOU: a daemon already current by shutdown time is not killed", async () => {
  // First health probe reports a stale version; every later probe is current —
  // as if a peer CLI finished the restart between our probe and our shutdown.
  let healthCalls = 0;
  let shutdowns = 0;
  await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") {
      healthCalls++;
      return void res.end(health(healthCalls === 1 ? "0.0.1" : VERSION));
    }
    if (req.method === "POST" && req.url === "/api/shutdown") {
      shutdowns++;
      return void res.end('{"ok":true}');
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const result = await ensureDaemon();
  expect(result.version).toBe(VERSION);
  expect(shutdowns).toBe(0); // the pre-shutdown re-check spared it
  expect(healthCalls).toBeGreaterThanOrEqual(2);
});

test("a peer's respawn during the post-shutdown wait is adopted, not killed again", async () => {
  // Stale until the shutdown POST lands; current immediately after — as if a
  // peer CLI respawned the new version into the gap while we were polling.
  let shutdowns = 0;
  await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") {
      return void res.end(health(shutdowns === 0 ? "0.0.1" : VERSION));
    }
    if (req.method === "POST" && req.url === "/api/shutdown") {
      shutdowns++;
      return void res.end('{"ok":true}');
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const result = await ensureDaemon();
  expect(result.version).toBe(VERSION);
  expect(shutdowns).toBe(1);
});

test("a stale daemon that exits on shutdown is replaced by a real spawned otacond", async () => {
  let shutdowns = 0;
  await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/health") return void res.end(health("0.0.1"));
    if (req.method === "POST" && req.url === "/api/shutdown") {
      shutdowns++;
      res.end('{"ok":true}');
      setImmediate(() => void closeServer()); // free the port for the respawn
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const result = await ensureDaemon();
  expect(shutdowns).toBe(1);
  expect(result.version).toBe(VERSION);
  expect(result.app).toBe("otacond");
  expect(result.pid).not.toBe(99999); // a real process, not the fake
  // Clean up the daemon this test actually spawned.
  const base = `http://127.0.0.1:${process.env.OTACON_PORT}`;
  await fetch(`${base}/api/shutdown`, { method: "POST" }).catch(() => undefined);
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(250) });
    } catch {
      break; // down — done
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 20000);
