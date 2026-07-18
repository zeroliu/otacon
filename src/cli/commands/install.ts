// otacon install --agent claude|codex|opencode [--agent …] | --all [--hooks] —
// write every managed protocol wrapper into each agent's skill location
// (install/update).
// Pure file writes — no daemon needed. Wrappers are managed files: reinstall
// overwrites them wholesale. --hooks additionally registers the Claude Code Stop
// hook in ~/.claude/settings.json — merged additively and idempotently, with a
// backup before the first change, never clobbering what cannot be parsed.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { STOP_HOOK_SCRIPT } from "../install/assets.js";
import {
  claudeHookScriptPath,
  claudeSettingsPath,
  claudeSkillPath,
  codexSkillPath,
  type InstallScope,
  type OtaconSkillName,
  mergeStopHook,
  opencodeSkillPath,
  settingsRegisterStopHook,
} from "../install/locations.js";
import { ensureNamedSkill, OTACON_SKILLS, type WrapperMode } from "../install/wrapper.js";
import { fail, notice, printJson, usageError } from "../output.js";
import { findRepoRoot } from "../session.js";

const AGENTS = ["claude", "codex", "opencode"] as const;
type Agent = (typeof AGENTS)[number];

export interface InstallCommandDeps {
  ensureNamedSkill?: typeof ensureNamedSkill;
}

type InstalledSkill = {
  name: OtaconSkillName;
  path: string;
  mode: WrapperMode;
};

type FailedSkill = {
  name: OtaconSkillName;
  path: string;
  error: string;
};

function writeManaged(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function installAgent(
  agent: Agent,
  scope: InstallScope,
  ensure: typeof ensureNamedSkill,
): {
  agent: Agent;
  files: string[];
  mode?: WrapperMode;
  skills: (InstalledSkill | FailedSkill)[];
} {
  const pathFor = (skill: OtaconSkillName): string => {
    switch (agent) {
      case "claude": return claudeSkillPath(scope, skill);
      case "codex": return codexSkillPath(scope, skill);
      case "opencode": return opencodeSkillPath(scope, skill);
    }
  };
  // One install action always binds every discoverable skill. Each complete
  // directory converges independently so no protocol can leak into another.
  const skills: (InstalledSkill | FailedSkill)[] = OTACON_SKILLS.map((name) => {
    const path = pathFor(name);
    try {
      const { mode } = ensure(name, path, scope.kind);
      return { name, path, mode };
    } catch (error) {
      // One blocked/corrupt destination must not prevent the other protocol or
      // another selected agent from being attempted. The final JSON reports
      // every failure and the command exits non-zero after convergence finishes.
      return { name, path, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const successful = skills.filter((skill): skill is InstalledSkill => "mode" in skill);
  const files = successful.map((skill) => skill.path);
  switch (agent) {
    case "claude": {
      // The Stop hook script lives in the user home only — it is never written at
      // project scope (DECISIONS.md "Stop hook deferred at project scope"), so a
      // committed `.claude/` ships an inert skill wrapper, never a hook pointing at
      // a script teammates may not have. `--hooks --project` is rejected upstream.
      if (scope.kind === "user") {
        writeManaged(claudeHookScriptPath(), STOP_HOOK_SCRIPT);
        chmodSync(claudeHookScriptPath(), 0o755);
        files.push(claudeHookScriptPath());
      }
      break;
    }
    case "codex":
    case "opencode":
      break;
  }
  // The legacy per-agent `mode` field described the plan skill. Do not fill it
  // from a successful review install when the plan destination itself failed.
  const compatibilityMode = successful.find((skill) => skill.name === "otacon")?.mode;
  return {
    agent,
    files,
    ...(compatibilityMode === undefined ? {} : { mode: compatibilityMode }),
    skills,
  };
}

interface HooksReport {
  registered: boolean;
  command: string;
  settings: string;
  backup?: string;
}

/** Register the Stop hook in ~/.claude/settings.json (additive, idempotent, backed up). */
function applyStopHook(): HooksReport {
  const path = claudeSettingsPath();
  const command = claudeHookScriptPath();
  let raw: unknown = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      fail(
        "E_SETTINGS_UNREADABLE",
        `${path} is not valid JSON; fix it by hand — otacon never overwrites settings it cannot parse`,
      );
    }
  }
  const merged = mergeStopHook(raw, command);
  if (!merged) {
    fail(
      "E_SETTINGS_SHAPE",
      `${path} has a hooks/hooks.Stop shape otacon cannot merge into; add the Stop hook by hand (command: ${command})`,
    );
  }
  if (!merged.changed) return { registered: true, command, settings: path };
  let backup: string | undefined;
  if (existsSync(path)) {
    backup = `${path}.otacon-backup-${Date.now()}`;
    copyFileSync(path, backup);
    notice(`backed up ${path} to ${backup}`);
  }
  writeManaged(path, `${JSON.stringify(merged.settings, null, 2)}\n`);
  notice(`registered the otacon Stop hook in ${path}`);
  return { registered: true, command, settings: path, ...(backup ? { backup } : {}) };
}

// Without --hooks: report registration state without nagging (install/update). The
// Stop hook is optional, so its absence is neither warned about nor "offered" — the
// JSON still factually carries `registered` for anyone who wants to wire it up.
function offerStopHook(): HooksReport {
  return {
    registered: settingsRegisterStopHook(),
    command: claudeHookScriptPath(),
    settings: claudeSettingsPath(),
  };
}

export async function installCommand(
  argv: string[],
  deps: InstallCommandDeps = {},
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string", multiple: true },
      all: { type: "boolean", default: false },
      hooks: { type: "boolean", default: false },
      project: { type: "boolean", default: false },
    },
  });
  const picked = values.all ? [...AGENTS] : ((values.agent ?? []) as string[]);
  if (picked.length === 0) {
    usageError("otacon install requires --agent claude|codex|opencode (repeatable) or --all");
  }
  const unknown = picked.find((a) => !(AGENTS as readonly string[]).includes(a));
  if (unknown !== undefined) {
    usageError(`unknown agent "${unknown}" — expected claude, codex, or opencode`);
  }
  const agents = [...new Set(picked)] as Agent[];
  if (values.hooks && !agents.includes("claude")) {
    usageError("--hooks registers the Claude Code Stop hook; include --agent claude (or --all)");
  }
  // The Stop hook is a user-level Claude Code registration; it is never installed at
  // project scope (DECISIONS.md "Stop hook deferred at project scope"), so the two
  // flags are mutually exclusive rather than silently picking one.
  if (values.hooks && values.project) {
    usageError(
      "--hooks installs a user-level Stop hook and cannot be combined with --project; run --hooks without --project",
    );
  }

  // --project resolves the install base to the current git repo root so the
  // wrappers can be committed and shared; outside any repo it is a hard error
  // (DECISIONS.md "`--project` resolves to the git repo root").
  let scope: InstallScope = { kind: "user" };
  if (values.project) {
    const cwd = process.cwd();
    const root = findRepoRoot(cwd);
    if (root === undefined) {
      usageError(`otacon install --project must run inside a git repo; none found at ${cwd}`);
    }
    scope = { kind: "project", root };
  }

  const ensure = deps.ensureNamedSkill ?? ensureNamedSkill;
  const installed = agents.map((agent) => installAgent(agent, scope, ensure));
  // The Stop hook report is user-only: at project scope --hooks is rejected, and
  // offerStopHook() would read the user ~/.claude/settings.json — misleading for a
  // project install — so the entire hooks branch is gated on user scope.
  const hooks =
    scope.kind === "user" && agents.includes("claude")
      ? values.hooks
        ? applyStopHook()
        : offerStopHook()
      : undefined;
  const failures = installed.flatMap((entry) => entry.skills
    .filter((skill): skill is FailedSkill => "error" in skill)
    .map((skill) => ({ agent: entry.agent, ...skill })));
  const ok = failures.length === 0;
  printJson({ ok, scope: scope.kind, installed, ...(failures.length === 0 ? {} : { failures }), ...(hooks ? { hooks } : {}) });
  return ok ? 0 : 1;
}
