// Best-effort Tailscale discovery shared by doctor and expose (DESIGN.md §11,
// §16). OTACON_TAILSCALE pins the binary (hermetic tests; nonstandard
// installs) and is authoritative when set; otherwise PATH, then the macOS app
// bundle's embedded CLI (DECISIONS.md "doctor/expose automation boundary").

import { execFileSync } from "node:child_process";

const MAC_APP_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export function findTailscale(): string | undefined {
  const override = process.env.OTACON_TAILSCALE;
  const candidates = override !== undefined && override !== "" ? [override] : ["tailscale", MAC_APP_BIN];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["version"], { stdio: ["ignore", "pipe", "ignore"] });
      return bin;
    } catch {
      // not this one
    }
  }
  return undefined;
}

export interface TailscaleStatus {
  /** e.g. "Running", "NeedsLogin", "Stopped". */
  backendState: string;
  /** This machine's MagicDNS name, trailing dot stripped; undefined when unknown. */
  dnsName?: string;
}

export function tailscaleStatus(bin: string): TailscaleStatus | undefined {
  try {
    const raw = JSON.parse(
      execFileSync(bin, ["status", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
    const dns = raw?.Self?.DNSName;
    return {
      backendState: typeof raw?.BackendState === "string" ? raw.BackendState : "unknown",
      ...(typeof dns === "string" && dns !== ""
        ? { dnsName: dns.replace(/\.$/, "") }
        : {}),
    };
  } catch {
    return undefined;
  }
}
