// otacon doctor — verify the machine setup (DESIGN.md §16): Node version,
// daemon boots and the port is free-or-ours (ensureDaemon does both), wrapper
// presence per agent, Stop hook registration, Tailscale state. Hard checks
// (node, daemon) fail the run with exit 1; everything optional — wrappers for
// agents the user may not use, phone access — is a warning, never a failure.

import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { otaconPort } from "../../shared/paths.js";
import { ensureDaemon } from "../client.js";
import { MANAGED_MARKER } from "../install/assets.js";
import {
  claudeHookScriptPath,
  claudeSkillPath,
  codexSkillPath,
  type InstallScope,
  opencodeSkillPath,
  settingsRegisterStopHook,
} from "../install/locations.js";
import { findTailscale, tailscaleStatus } from "../install/tailscale.js";
import { CliError, printJson } from "../output.js";
import { findRepoRoot } from "../session.js";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

/** A candidate wrapper path tagged with the scope that produced it (for `detail`). */
export interface WrapperCandidate {
  path: string;
  scope: "user" | "project";
}

function wrapperPresent(path: string, marker: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").includes(marker);
}

// A wrapper is the otacon protocol skill (the SKILL.md `otacon install` writes); it's
// optional, so absence is a warn, never a failure. When run inside a repo, accept the
// wrapper at EITHER the user path or the project path so a `--project` install doesn't
// trip a spurious "not installed" warning — report whichever scope satisfied it.
export function wrapperCheck(name: string, candidates: WrapperCandidate[], marker: string): Check {
  const hit = candidates.find((c) => wrapperPresent(c.path, marker));
  if (hit) return { name, status: "ok", detail: `${hit.path} (${hit.scope})` };
  const agent = name.replace("wrapper-", "");
  const looked = candidates.map((c) => c.path).join(" and ");
  const projectHint = candidates.some((c) => c.scope === "project")
    ? " or add --project to install it into this repo"
    : "";
  return {
    name,
    status: "warn",
    detail: `otacon protocol skill not found for ${agent} (looked in ${looked}); run \`otacon install --agent ${agent}\`${projectHint}`,
  };
}

// The Stop hook is optional — a belt-and-suspenders guard on top of the skill's
// never-end-your-turn rule, not a required piece. Confirm it when wired up, but
// never flag its absence (return undefined → omitted from the report, no warning).
function stopHookCheck(): Check | undefined {
  if (!settingsRegisterStopHook()) return undefined;
  return { name: "stop-hook", status: "ok", detail: claudeHookScriptPath() };
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

  // When in a git repo, also accept a project-scope wrapper (otacon install --project)
  // so a committed `.claude`/`.codex`/`.opencode` doesn't read as "not installed".
  const projectRoot = findRepoRoot(process.cwd());
  const project: InstallScope | undefined =
    projectRoot === undefined ? undefined : { kind: "project", root: projectRoot };
  const candidates = (
    skillPath: (scope?: InstallScope) => string,
  ): WrapperCandidate[] => [
    { path: skillPath(), scope: "user" },
    ...(project ? [{ path: skillPath(project), scope: "project" as const }] : []),
  ];
  checks.push(wrapperCheck("wrapper-claude", candidates(claudeSkillPath), MANAGED_MARKER));
  checks.push(wrapperCheck("wrapper-codex", candidates(codexSkillPath), MANAGED_MARKER));
  checks.push(wrapperCheck("wrapper-opencode", candidates(opencodeSkillPath), MANAGED_MARKER));
  const stopHook = stopHookCheck();
  if (stopHook) checks.push(stopHook);
  checks.push(tailscaleCheck());

  const ok = checks.every((c) => c.status !== "fail");
  printJson({ ok, checks });
  return ok ? 0 : 1;
}
