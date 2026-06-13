// otacon doctor — verify the machine setup (DESIGN.md §16): Node version,
// daemon boots and the port is free-or-ours (ensureDaemon does both), wrapper
// presence per agent, Stop hook registration, Tailscale state. Hard checks
// (node, daemon) fail the run with exit 1; everything optional — wrappers for
// agents the user may not use, phone access — is a warning, never a failure.

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { otaconPort } from "../../shared/paths.js";
import { ensureDaemon } from "../client.js";
import { CODEX_BEGIN, MANAGED_MARKER } from "../install/assets.js";
import {
  claudeHookScriptPath,
  claudeSkillPath,
  codexAgentsPath,
  opencodeSkillPath,
  settingsRegisterStopHook,
} from "../install/locations.js";
import { findTailscale, tailscaleStatus } from "../install/tailscale.js";
import { CliError, printJson } from "../output.js";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function wrapperCheck(name: string, path: string, marker: string): Check {
  const present = existsSync(path) && readFileSync(path, "utf8").includes(marker);
  return present
    ? { name, status: "ok", detail: path }
    : {
        name,
        status: "warn",
        detail: `wrapper not installed at ${path}; run otacon install --agent ${name.replace("wrapper-", "")}`,
      };
}

function stopHookCheck(): Check {
  const name = "stop-hook";
  if (settingsRegisterStopHook()) {
    return { name, status: "ok", detail: claudeHookScriptPath() };
  }
  return {
    name,
    status: "warn",
    detail: "Stop hook not registered; run otacon install --agent claude --hooks",
  };
}

function tailscaleCheck(): Check {
  const name = "tailscale";
  const bin = findTailscale();
  if (bin === undefined) {
    return {
      name,
      status: "warn",
      detail: "tailscale CLI not found — phone access is optional (DESIGN.md §11; otacon expose)",
    };
  }
  const status = tailscaleStatus(bin);
  if (status?.backendState === "Running") {
    return { name, status: "ok", detail: `${bin} (${status.dnsName ?? "no MagicDNS name"})` };
  }
  return {
    name,
    status: "warn",
    detail: `tailscale backend is ${status?.backendState ?? "unreachable"}; run \`tailscale up\` before otacon expose`,
  };
}

export async function doctorCommand(argv: string[]): Promise<number> {
  parseArgs({ args: argv, options: {} });
  const checks: Check[] = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 20
      ? { name: "node", status: "ok", detail: `node ${process.versions.node}` }
      : { name: "node", status: "fail", detail: `node ${process.versions.node} — otacon needs >=20` },
  );

  try {
    const health = await ensureDaemon();
    checks.push({
      name: "daemon",
      status: "ok",
      detail: `otacond ${health.version} (pid ${health.pid}) on port ${otaconPort()}`,
    });
  } catch (error) {
    checks.push({
      name: "daemon",
      status: "fail",
      detail: error instanceof CliError ? `${error.code}: ${error.message}` : String(error),
    });
  }

  checks.push(wrapperCheck("wrapper-claude", claudeSkillPath(), MANAGED_MARKER));
  checks.push(wrapperCheck("wrapper-codex", codexAgentsPath(), CODEX_BEGIN));
  checks.push(wrapperCheck("wrapper-opencode", opencodeSkillPath(), MANAGED_MARKER));
  checks.push(stopHookCheck());
  checks.push(tailscaleCheck());

  const ok = checks.every((c) => c.status !== "fail");
  printJson({ ok, checks });
  return ok ? 0 : 1;
}
