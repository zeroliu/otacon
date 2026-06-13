import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { verifyServing } from "./expose.js";

// verifyServing is the honest check that `tailscale serve` is really serving:
// `serve --bg` exits 0 once its config is written, so expose can't trust that
// alone (DECISIONS.md "expose verifies"). These tests drive it against real
// loopback servers and dead/unresolvable endpoints.

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** Start a loopback server that answers every request with `status`; returns its base URL. */
function serveStatus(status: number): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/`);
    });
  });
}

test("returns true when <url>api/health answers 2xx", async () => {
  const url = await serveStatus(200);
  expect(await verifyServing(url, { attempts: 1, delayMs: 0 })).toBe(true);
});

test("returns false when the URL answers non-2xx (e.g. proxy 502)", async () => {
  const url = await serveStatus(502);
  expect(await verifyServing(url, { attempts: 2, delayMs: 0 })).toBe(false);
});

test("returns false when the host does not resolve (the stub/foreign tailnet case)", async () => {
  // .invalid is a reserved TLD that never resolves → fetch rejects fast every
  // attempt; with no inter-attempt delay this stays sub-second.
  expect(await verifyServing("https://otacon-nope.invalid./", { attempts: 2, delayMs: 0 })).toBe(
    false,
  );
});

test("returns false when nothing is listening on the port", async () => {
  const url = await serveStatus(200);
  const dead = servers.pop()!; // pull it out of afterEach cleanup
  await new Promise<void>((r) => dead.close(() => r()));
  // short per-attempt timeout: a dead loopback port rejects instantly on Node
  // (production), but Bun's fetch can stall until the abort fires.
  expect(await verifyServing(url, { attempts: 2, delayMs: 0, timeoutMs: 500 })).toBe(false);
});
