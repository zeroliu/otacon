// otacon expose — configure phone access over Tailscale (DESIGN.md §11, §16):
// verify the tailscale CLI exists and is logged in, make sure the daemon is
// up, run `tailscale serve --bg` against the daemon port, then confirm the
// tailnet URL actually serves before printing it. Deliberately thin: install,
// login (`tailscale up`), and tailnet HTTPS enablement are interactive/
// account-level steps this command points at instead of automating (DECISIONS.md
// "doctor/expose automation boundary").

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { otaconPort } from "../../shared/paths.js";
import { ensureDaemon, sleep } from "../client.js";
import { fail, notice, printJson } from "../output.js";
import { findTailscale, tailscaleStatus } from "../install/tailscale.js";

const VERIFY_ATTEMPTS = 3;
const VERIFY_DELAY_MS = 2000;
const VERIFY_TIMEOUT_MS = 5000;

/**
 * Confirm `tailscale serve` is actually serving the tailnet URL. `serve --bg`
 * exits 0 the moment its config is written, but the HTTPS frontend resets every
 * TLS handshake until the tailnet has HTTPS Certificates enabled — so a bare
 * `ok:true` is a false positive (the phone just sees a dead URL). A real GET of
 * `<url>api/health` is the only honest check. Failures (TLS reset, unresolved
 * name, refused) reject fast, so a few bounded retries ride out cold-cert
 * provisioning right after enablement without ever hanging the command.
 */
export async function verifyServing(
  url: string,
  opts: { attempts?: number; delayMs?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? VERIFY_ATTEMPTS;
  const delayMs = opts.delayMs ?? VERIFY_DELAY_MS;
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const healthUrl = new URL("api/health", url).toString();
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return true;
    } catch {
      // unreachable / TLS reset / DNS miss / timeout — retry or give up below
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return false;
}

/** Verification timing is env-overridable so the e2e stays fast and hermetic. */
function verifyOptsFromEnv(): { attempts?: number; delayMs?: number; timeoutMs?: number } {
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  return {
    attempts: num(process.env.OTACON_EXPOSE_VERIFY_ATTEMPTS),
    delayMs: num(process.env.OTACON_EXPOSE_VERIFY_DELAY_MS),
    timeoutMs: num(process.env.OTACON_EXPOSE_VERIFY_TIMEOUT_MS),
  };
}

export async function exposeCommand(argv: string[]): Promise<number> {
  parseArgs({ args: argv, options: {} });

  const bin = findTailscale();
  if (bin === undefined) {
    fail(
      "E_TAILSCALE_MISSING",
      "tailscale CLI not found — install Tailscale and log in first (DESIGN.md §11; README \"Phone access\"), or set OTACON_TAILSCALE to the binary",
    );
  }
  const status = tailscaleStatus(bin);
  if (status === undefined) {
    fail("E_TAILSCALE_STATUS", `\`${bin} status --json\` failed — is the Tailscale daemon running?`);
  }
  if (status.backendState !== "Running") {
    fail(
      "E_TAILSCALE_NOT_RUNNING",
      `tailscale backend is ${status.backendState}; run \`tailscale up\` (log in), then retry`,
    );
  }

  await ensureDaemon(); // something must be listening before we serve it
  const port = otaconPort();
  const target = `http://127.0.0.1:${port}`;
  try {
    execFileSync(bin, ["serve", "--bg", target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: unknown })?.stderr;
    const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : String(error);
    fail(
      "E_TAILSCALE_SERVE",
      `\`tailscale serve --bg ${target}\` failed: ${detail} (HTTPS certificates may need enabling on the tailnet — DESIGN.md §11)`,
    );
  }

  const url = status.dnsName !== undefined ? `https://${status.dnsName}/` : undefined;
  if (url === undefined) {
    notice("could not determine the tailnet DNS name; run `tailscale serve status` to find the URL");
    printJson({ ok: true, target, port });
    return 0;
  }

  // `serve --bg` succeeding only means the config was written — confirm the URL
  // actually answers before handing it over (DECISIONS.md "expose verifies").
  const verified = await verifyServing(url, verifyOptsFromEnv());
  if (!verified) {
    notice(
      `serve is configured but ${url} did not respond. The usual cause is that HTTPS ` +
        "Certificates are not enabled for your tailnet — enable them (admin console → " +
        "DNS → Enable HTTPS): https://login.tailscale.com/admin/dns , then retry. " +
        "(Just enabled them? The cert may still be provisioning — give it a minute.)",
    );
  }
  printJson({ ok: true, target, port, url, verified });
  return 0;
}
