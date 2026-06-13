// Where each agent reads its wrapper from (DESIGN.md §16; DECISIONS.md
// "Wrapper destinations per agent"), plus the pure merge helpers install and
// doctor share. homedir() honors $HOME, which is what keeps the install e2e
// hermetic under a temp HOME.

import { homedir } from "node:os";
import { join } from "node:path";

export function claudeSkillPath(): string {
  return join(homedir(), ".claude", "skills", "otacon", "SKILL.md");
}

/** The Stop hook script install writes; settings.json references it by this path. */
export function claudeHookScriptPath(): string {
  return join(homedir(), ".claude", "hooks", "otacon-stop.sh");
}

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

/** Codex's global instructions file ($CODEX_HOME, default ~/.codex). */
export function codexAgentsPath(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "AGENTS.md");
}

/** OpenCode's global skills dir ($XDG_CONFIG_HOME, default ~/.config). */
export function opencodeSkillPath(): string {
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "opencode",
    "skills",
    "otacon",
    "SKILL.md",
  );
}

/**
 * Replace the marker-delimited block in `existing` with `block` (which carries
 * its own begin/end lines), or append it when no markers are present. User
 * content outside the markers survives byte-for-byte; re-running with the same
 * block is a fixpoint (the idempotent-reinstall contract).
 */
export function upsertMarkedBlock(
  existing: string,
  block: string,
  begin: string,
  end: string,
): string {
  const from = existing.indexOf(begin);
  const to = existing.indexOf(end);
  if (from !== -1 && to !== -1 && to > from) {
    return existing.slice(0, from) + block + existing.slice(to + end.length);
  }
  if (existing.trim() === "") return `${block}\n`;
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${separator}${block}\n`;
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
