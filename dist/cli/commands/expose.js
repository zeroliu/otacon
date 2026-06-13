// otacon expose — configure phone access over Tailscale (DESIGN.md §11, §16):
// verify the tailscale CLI exists and is logged in, make sure the daemon is
// up, run `tailscale serve --bg` against the daemon port, print the tailnet
// URL to bookmark. Deliberately thin: install, login (`tailscale up`), and
// tailnet HTTPS enablement are interactive/account-level steps this command
// points at instead of automating (DECISIONS.md "doctor/expose automation
// boundary").
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { otaconPort } from "../../shared/paths.js";
import { ensureDaemon } from "../client.js";
import { fail, notice, printJson } from "../output.js";
import { findTailscale, tailscaleStatus } from "../install/tailscale.js";
export async function exposeCommand(argv) {
    parseArgs({ args: argv, options: {} });
    const bin = findTailscale();
    if (bin === undefined) {
        fail("E_TAILSCALE_MISSING", "tailscale CLI not found — install Tailscale and log in first (DESIGN.md §11; README \"Phone access\"), or set OTACON_TAILSCALE to the binary");
    }
    const status = tailscaleStatus(bin);
    if (status === undefined) {
        fail("E_TAILSCALE_STATUS", `\`${bin} status --json\` failed — is the Tailscale daemon running?`);
    }
    if (status.backendState !== "Running") {
        fail("E_TAILSCALE_NOT_RUNNING", `tailscale backend is ${status.backendState}; run \`tailscale up\` (log in), then retry`);
    }
    await ensureDaemon(); // something must be listening before we serve it
    const port = otaconPort();
    const target = `http://127.0.0.1:${port}`;
    try {
        execFileSync(bin, ["serve", "--bg", target], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    }
    catch (error) {
        const stderr = error?.stderr;
        const detail = typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : String(error);
        fail("E_TAILSCALE_SERVE", `\`tailscale serve --bg ${target}\` failed: ${detail} (HTTPS certificates may need enabling on the tailnet — DESIGN.md §11)`);
    }
    const url = status.dnsName !== undefined ? `https://${status.dnsName}/` : undefined;
    if (url === undefined) {
        notice("could not determine the tailnet DNS name; run `tailscale serve status` to find the URL");
    }
    printJson({ ok: true, target, port, ...(url !== undefined ? { url } : {}) });
    return 0;
}
//# sourceMappingURL=expose.js.map