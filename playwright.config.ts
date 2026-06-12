import { mkdtempSync } from "node:fs";
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

export default defineConfig({
  testDir: "test/ui",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node dist/daemon/main.js",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: {
      OTACON_HOME: mkdtempSync(join(tmpdir(), "otacon-ui-e2e-home-")),
      OTACON_PORT: String(port),
    },
  },
});
