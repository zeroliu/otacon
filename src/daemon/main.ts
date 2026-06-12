#!/usr/bin/env node
// otacond entry point: bind the Hono app to 127.0.0.1 only (DESIGN.md §3;
// remote access is Tailscale's job, never a wider bind).

import { serve } from "@hono/node-server";
import { otaconPort } from "../shared/paths.js";
import { VERSION } from "../shared/version.js";
import { createApp } from "./app.js";
import { Store } from "./store.js";

const HOST = "127.0.0.1";
const port = otaconPort();

const app = createApp({
  store: new Store(),
  // The shutdown route invokes this only after its response is written
  // (or the client is gone), so exiting immediately is safe.
  onShutdown: () => process.exit(0),
});

const server = serve({ fetch: app.fetch, hostname: HOST, port }, (info) => {
  process.stdout.write(
    `${JSON.stringify({ app: "otacond", version: VERSION, host: HOST, port: info.port, pid: process.pid })}\n`,
  );
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    // The port is the lock (DECISIONS.md "Spawn race"): losing the bind to
    // another otacond is success; squatting by anything else refuses to start.
    void exitPerPortOwner();
  } else {
    process.stderr.write(`otacond: ${error.message}\n`);
    process.exit(1);
  }
});

async function exitPerPortOwner(): Promise<void> {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const health = (await response.json()) as { app?: string; version?: string };
    if (health.app === "otacond") {
      process.stdout.write(
        `${JSON.stringify({ app: "otacond", note: "already running", version: health.version, host: HOST, port })}\n`,
      );
      process.exit(0);
    }
  } catch {
    // Not an otacond (or not even HTTP) — fall through to the refusal.
  }
  process.stderr.write(
    `otacond: port ${port} is in use by something that is not otacond; set OTACON_PORT to pick another port\n`,
  );
  process.exit(1);
}
