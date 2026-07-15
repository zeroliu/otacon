import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../../shared/version.js";
import { cleanCommand } from "./clean.js";

let server: Server | undefined;
let savedPort: string | undefined;
let savedCwd: string;
let cwd: string;
let deleted: string[];

async function listen(detailStatus: "draft" | "approved"): Promise<void> {
  const session = {
    kind: "plan",
    id: "otc_clean1",
    title: "finished plan",
    repo: cwd,
    branch: "main",
    quick: false,
    socratic: false,
    status: "approved",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/health") {
      return void response.end(JSON.stringify({ app: "otacond", version: VERSION, pid: 99999 }));
    }
    if (request.method === "GET" && request.url === "/api/sessions") {
      return void response.end(JSON.stringify({ sessions: [session] }));
    }
    if (request.method === "DELETE" && request.url === "/api/sessions/otc_clean1?terminalOnly=true") {
      if (detailStatus !== "approved") {
        response.statusCode = 409;
        return void response.end(JSON.stringify({
          error: { code: "E_SESSION_NOT_TERMINAL", message: "session is no longer ended" },
        }));
      }
      deleted.push("otc_clean1");
      return void response.end(JSON.stringify({ ok: true, pendingEvents: 0 }));
    }
    response.statusCode = 404;
    response.end("{}");
  };
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  process.env.OTACON_PORT = String((server.address() as AddressInfo).port);
}

async function run(): Promise<Record<string, unknown>> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let printed: Record<string, unknown> = {};
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    printed = JSON.parse(String(chunk)) as Record<string, unknown>;
    return true;
  }) as typeof process.stdout.write;
  try {
    expect(await cleanCommand([])).toBe(0);
    return printed;
  } finally {
    process.stdout.write = originalWrite;
  }
}

beforeEach(() => {
  savedPort = process.env.OTACON_PORT;
  savedCwd = process.cwd();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "otacon-clean-")));
  process.chdir(cwd);
  deleted = [];
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

test("asks the daemon to atomically revalidate a terminal snapshot before deletion", async () => {
  await listen("draft");
  expect(await run()).toMatchObject({ ok: true, cleaned: [] });
  expect(deleted).toEqual([]);
});

test("deletes a session that remains terminal at the point of removal", async () => {
  await listen("approved");
  expect(await run()).toMatchObject({
    ok: true,
    cleaned: [{ session: "otc_clean1", title: "finished plan", repo: cwd }],
  });
  expect(deleted).toEqual(["otc_clean1"]);
});
