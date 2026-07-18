// Where each agent reads its wrapper from (install/update; DECISIONS.md
// "Wrapper destinations per agent"), plus the merge/registration helpers
// install and doctor share. homedir() honors $HOME, which is what keeps the
// install e2e hermetic under a temp HOME.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a wrapper is installed: the user's home (today's default) or a specific
 * git repo root (`otacon install --project`). The three skill-path helpers below
 * branch on `kind`; hooks are user-only, so the hook/settings helpers ignore it.
 */
export type InstallScope = { kind: "user" } | { kind: "project"; root: string };

/**
 * The independently-discoverable skills shipped by one Otacon install: the two
 * daemon-backed protocol cards plus the agent-side Plan V2 prototype cards
 * (plan + implement + review).
 */
export type OtaconSkillName =
  | "otacon"
  | "otacon-review"
  | "otacon-plan-v2"
  | "otacon-implement-v2"
  | "otacon-review-v2";

export function claudeSkillPath(
  scope: InstallScope = { kind: "user" },
  skill: OtaconSkillName = "otacon",
): string {
  const base = scope.kind === "project" ? scope.root : homedir();
  return join(base, ".claude", "skills", skill, "SKILL.md");
}

/** The Stop hook script install writes; settings.json references it by this path. */
export function claudeHookScriptPath(): string {
  return join(homedir(), ".claude", "hooks", "otacon-stop.sh");
}

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** Codex's skills dir — user: $CODEX_HOME (default ~/.codex); project: <root>/.codex. */
export function codexSkillPath(
  scope: InstallScope = { kind: "user" },
  skill: OtaconSkillName = "otacon",
): string {
  const base =
    scope.kind === "project"
      ? join(scope.root, ".codex")
      : (process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  return join(base, "skills", skill, "SKILL.md");
}

/** OpenCode's skills dir — user: $XDG_CONFIG_HOME/opencode (default ~/.config); project: <root>/.opencode. */
export function opencodeSkillPath(
  scope: InstallScope = { kind: "user" },
  skill: OtaconSkillName = "otacon",
): string {
  const base =
    scope.kind === "project"
      ? join(scope.root, ".opencode")
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
  return join(base, "skills", skill, "SKILL.md");
}

/**
 * Whether ~/.claude/settings.json currently registers the otacon Stop hook
 * (install's offer path and doctor's check). Missing or unparseable settings
 * read as "not registered" — only --hooks treats unparseable as an error.
 */
export function settingsRegisterStopHook(): boolean {
  try {
    const raw = JSON.parse(readFileSync(claudeSettingsPath(), "utf8")) as {
      hooks?: { Stop?: unknown };
    };
    return stopHookRegistered(raw?.hooks?.Stop, claudeHookScriptPath());
  } catch {
    return false;
  }
}

/** True when some Stop matcher entry already runs `command`. */
export function stopHookRegistered(stop: unknown, command: string): boolean {
  if (!Array.isArray(stop)) return false;
  return stop.some((entry) => {
    const hooks = (entry as { hooks?: unknown } | null)?.hooks;
    return (
      Array.isArray(hooks) &&
      hooks.some((h) => (h as { command?: unknown } | null)?.command === command)
    );
  });
}

export interface StopHookMerge {
  settings: Record<string, unknown>;
  changed: boolean;
}

/**
 * Additively merge the Stop hook entry into a parsed settings.json: every
 * existing key (and every existing Stop matcher) is preserved; an entry already
 * running `command` makes this a no-op. Returns undefined when the existing
 * structure has a shape we refuse to rewrite (hooks or hooks.Stop not
 * object/array) — never clobber what we cannot faithfully merge.
 */
export function mergeStopHook(raw: unknown, command: string): StopHookMerge | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const settings = raw as Record<string, unknown>;
  const hooks = settings.hooks ?? {};
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) return undefined;
  const stop = (hooks as Record<string, unknown>).Stop ?? [];
  if (!Array.isArray(stop)) return undefined;
  if (stopHookRegistered(stop, command)) return { settings, changed: false };
  const entry = { matcher: "", hooks: [{ type: "command", command }] };
  return {
    settings: { ...settings, hooks: { ...hooks, Stop: [...stop, entry] } },
    changed: true,
  };
}
