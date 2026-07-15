import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { skillMd, STOP_HOOK_SCRIPT } from "./assets.js";
import {
  claudeSkillPath,
  codexSkillPath,
  mergeStopHook,
  opencodeSkillPath,
  stopHookRegistered,
} from "./locations.js";

const HOOK = "/home/zero/.claude/hooks/otacon-stop.sh";

describe("mergeStopHook", () => {
  test("adds the Stop entry to empty settings", () => {
    const merged = mergeStopHook({}, HOOK);
    expect(merged?.changed).toBe(true);
    const stop = (merged?.settings.hooks as { Stop: unknown[] }).Stop;
    expect(stop).toHaveLength(1);
    expect(stopHookRegistered(stop, HOOK)).toBe(true);
  });

  test("preserves unrelated keys, hooks, and existing Stop matchers", () => {
    const existing = {
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "/usr/bin/other-hook" }] }],
      },
    };
    const merged = mergeStopHook(existing, HOOK);
    expect(merged?.changed).toBe(true);
    const settings = merged?.settings as typeof existing;
    expect(settings.model).toBe("opus");
    expect(settings.permissions.allow).toEqual(["Bash(ls:*)"]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(2);
    expect((settings.hooks.Stop[0] as { hooks: { command: string }[] }).hooks[0]?.command).toBe(
      "/usr/bin/other-hook",
    );
  });

  test("is a no-op when the hook is already registered", () => {
    const first = mergeStopHook({}, HOOK);
    const second = mergeStopHook(first?.settings, HOOK);
    expect(second?.changed).toBe(false);
    expect(second?.settings).toEqual(first?.settings as Record<string, unknown>);
  });

  test("refuses shapes it cannot faithfully merge", () => {
    expect(mergeStopHook([], HOOK)).toBeUndefined();
    expect(mergeStopHook("nope", HOOK)).toBeUndefined();
    expect(mergeStopHook({ hooks: "nope" }, HOOK)).toBeUndefined();
    expect(mergeStopHook({ hooks: { Stop: {} } }, HOOK)).toBeUndefined();
  });
});

describe("scope-aware skill paths", () => {
  // Each helper has a user branch (homedir/$CODEX_HOME/$XDG_CONFIG_HOME) and a
  // project branch (<root>/...). Pin the env so the user-branch assertions are
  // deterministic regardless of the host's environment.
  let savedCodexHome: string | undefined;
  let savedXdg: string | undefined;

  beforeEach(() => {
    savedCodexHome = process.env.CODEX_HOME;
    savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.CODEX_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  });

  const REL = join("skills", "otacon", "SKILL.md");

  test("user scope is the default and roots under homedir / env bases", () => {
    expect(claudeSkillPath()).toBe(join(homedir(), ".claude", REL));
    expect(claudeSkillPath({ kind: "user" })).toBe(join(homedir(), ".claude", REL));
    // Codex user base is $CODEX_HOME (default ~/.codex), opencode user base is
    // $XDG_CONFIG_HOME/opencode (default ~/.config/opencode) — both then /skills/.
    expect(codexSkillPath()).toBe(join(homedir(), ".codex", REL));
    expect(opencodeSkillPath()).toBe(join(homedir(), ".config", "opencode", REL));
  });

  test("user scope honors $CODEX_HOME and $XDG_CONFIG_HOME", () => {
    process.env.CODEX_HOME = "/custom/codex";
    process.env.XDG_CONFIG_HOME = "/custom/xdg";
    expect(codexSkillPath({ kind: "user" })).toBe(join("/custom/codex", REL));
    expect(opencodeSkillPath({ kind: "user" })).toBe(join("/custom/xdg", "opencode", REL));
  });

  test("project scope roots every agent under the repo root (env-independent)", () => {
    process.env.CODEX_HOME = "/custom/codex"; // must be ignored at project scope
    process.env.XDG_CONFIG_HOME = "/custom/xdg";
    const root = "/repo";
    const scope = { kind: "project", root } as const;
    expect(claudeSkillPath(scope)).toBe(join(root, ".claude", REL));
    expect(codexSkillPath(scope)).toBe(join(root, ".codex", REL));
    expect(opencodeSkillPath(scope)).toBe(join(root, ".opencode", REL));
  });

  test("each agent resolves a distinct review skill at user and project scope", () => {
    const reviewRel = join("skills", "otacon-review", "SKILL.md");
    const project = { kind: "project", root: "/repo" } as const;
    expect(claudeSkillPath({ kind: "user" }, "otacon-review")).toBe(
      join(homedir(), ".claude", reviewRel),
    );
    expect(claudeSkillPath(project, "otacon-review")).toBe(join("/repo", ".claude", reviewRel));
    expect(codexSkillPath({ kind: "user" }, "otacon-review")).toBe(
      join(homedir(), ".codex", reviewRel),
    );
    expect(codexSkillPath(project, "otacon-review")).toBe(join("/repo", ".codex", reviewRel));
    expect(opencodeSkillPath({ kind: "user" }, "otacon-review")).toBe(
      join(homedir(), ".config", "opencode", reviewRel),
    );
    expect(opencodeSkillPath(project, "otacon-review")).toBe(join("/repo", ".opencode", reviewRel));
  });
});

describe("wrapper assets", () => {
  test("the protocol card carries every load-bearing command", () => {
    const text = skillMd();
    for (const needle of [
      "otacon start --title",
      "otacon ask --question",
      "otacon wait --timeout 540",
      "otacon submit --resolutions resolutions.json",
      "otacon answer",
      "otacon status",
      "Never end your turn",
      "caffeinate -i",
      "600000 ms",
      // Visuals guidance (plan structure, lint, and anchoring): the three primitives + soft SHOULDs.
      "## Visuals",
      "[!risk]",
      "SHOULD use a matrix",
      "[new]",
    ]) {
      expect(text).toContain(needle);
    }
    expect(text.startsWith("---\nname: otacon\n")).toBe(true);
  });

  test("the Stop hook script is plain sh, fail-open, and emits the block decision", () => {
    expect(STOP_HOOK_SCRIPT.startsWith("#!/bin/sh\n")).toBe(true);
    expect(STOP_HOOK_SCRIPT).toContain('"decision":"block"');
    expect(STOP_HOOK_SCRIPT).toContain("exit 0");
    // It drops ALL terminal statuses so a finished build no longer traps the
    // agent, while an in-flight `implementing` session still blocks the stop.
    expect(STOP_HOOK_SCRIPT).toContain("approved|implemented|implement_failed|done");
    expect(STOP_HOOK_SCRIPT).toContain('[ "$kind" = "review" ]');
    expect(STOP_HOOK_SCRIPT).toContain("otacon wait --session %s --timeout 540");
    expect(STOP_HOOK_SCRIPT.match(/otacon wait --session %s --timeout 540/g)).toHaveLength(2);
    expect(STOP_HOOK_SCRIPT).toContain("until review-done or deleted");
    expect(STOP_HOOK_SCRIPT).toContain("until the plan is approved");
  });
});
