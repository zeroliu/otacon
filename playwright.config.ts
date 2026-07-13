import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The UI e2e suite drives the REAL built daemon (node dist/daemon/main.js)
// against a throwaway OTACON_HOME on a non-default port — the same posture as
// test/e2e-daemon.sh. Specs are *.e2e.ts so `bun test` (which auto-discovers
// *.test.* and *.spec.*) never tries to execute them (DECISIONS.md
// "Playwright e2e drive the real daemon; specs are *.e2e.ts").

// The daemon is loopback-only; never let an HTTP(S)_PROXY env (dev shells,
// CI sandboxes) intercept the health probe or the API fixtures.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");

const port = Number(process.env.OTACON_E2E_PORT ?? "4790");
const baseURL = `http://127.0.0.1:${port}`;

// Hermetic, like e2e-daemon.sh: disable desktop banners so submitting/asking
// against the real daemon never pops a native macOS notification on the dev Mac.
const e2eHome = mkdtempSync(join(tmpdir(), "otacon-ui-e2e-home-"));
writeFileSync(join(e2eHome, "config.json"), '{"notifications":{"desktop":false}}');

export default defineConfig({
  testDir: "test/ui",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  // The whole suite drives ONE real daemon (a single Node HTTP server). Each
  // worker opens SSE streams and spawns real `otacon wait` long-polls, so a high
  // worker count saturates that one process — its keep-alive connections get
  // reset mid-flight (`ECONNRESET` on the API client), and the failure count
  // scales with concurrency (≈1 → 8 → 24 at 2 → 4 → 9 workers). Cap the workers
  // so the shared daemon is never overwhelmed, and keep a small retry budget to
  // absorb the rare residual reset; the suite is then deterministically green.
  // (The production daemon serves one human + their agent, not a worker fleet, so
  // this is a test-harness concern, not a daemon bug to fix in product code.)
  workers: 2,
  retries: 2,
  reporter: "list",
  use: { baseURL },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node dist/daemon/main.js",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: {
      OTACON_HOME: e2eHome,
      OTACON_PORT: String(port),
    },
  },
});
