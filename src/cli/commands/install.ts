// otacon install --agent claude|codex|opencode [--agent …] | --all [--hooks] —
// write the protocol wrapper into each agent's skill location (install/update).
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
  mergeStopHook,
  opencodeSkillPath,
  settingsRegisterStopHook,
} from "../install/locations.js";
import { ensureWrapper, type WrapperMode } from "../install/wrapper.js";
import { fail, notice, printJson, usageError } from "../output.js";
import { findRepoRoot } from "../session.js";

const AGENTS = ["claude", "codex", "opencode"] as const;
type Agent = (typeof AGENTS)[number];

function writeManaged(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function installAgent(
  agent: Agent,
  scope: InstallScope,
): { agent: Agent; files: string[]; mode: WrapperMode } {
  switch (agent) {
    case "claude": {
      const skill = claudeSkillPath(scope);
      // The skill wrapper is symlinked at user scope (auto-refreshes on binary
      // upgrade) and copied at project scope (a committed file must be machine
      // independent); ensureWrapper decides and reports which.
      const { mode } = ensureWrapper(skill, scope.kind);
      // The Stop hook script lives in the user home only — it is never written at
      // project scope (DECISIONS.md "Stop hook deferred at project scope"), so a
      // committed `.claude/` ships an inert skill wrapper, never a hook pointing at
      // a script teammates may not have. `--hooks --project` is rejected upstream.
      if (scope.kind === "user") {
        writeManaged(claudeHookScriptPath(), STOP_HOOK_SCRIPT);
        chmodSync(claudeHookScriptPath(), 0o755);
        return { agent, files: [skill, claudeHookScriptPath()], mode };
      }
      return { agent, files: [skill], mode };
    }
    case "codex": {
      const skill = codexSkillPath(scope);
      const { mode } = ensureWrapper(skill, scope.kind);
      return { agent, files: [skill], mode };
    }
    case "opencode": {
      const skill = opencodeSkillPath(scope);
      const { mode } = ensureWrapper(skill, scope.kind);
      return { agent, files: [skill], mode };
    }
  }
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

export async function installCommand(argv: string[]): Promise<number> {
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

  const installed = agents.map((agent) => installAgent(agent, scope));
  // The Stop hook report is user-only: at project scope --hooks is rejected, and
  // offerStopHook() would read the user ~/.claude/settings.json — misleading for a
  // project install — so the entire hooks branch is gated on user scope.
  const hooks =
    scope.kind === "user" && agents.includes("claude")
      ? values.hooks
        ? applyStopHook()
        : offerStopHook()
      : undefined;
  printJson({ ok: true, scope: scope.kind, installed, ...(hooks ? { hooks } : {}) });
  return 0;
}
