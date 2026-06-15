import { describe, expect, test } from "bun:test";
import { CODEX_BEGIN, CODEX_END, codexBlock, skillMd, STOP_HOOK_SCRIPT } from "./assets.js";
import { mergeStopHook, stopHookRegistered, upsertMarkedBlock } from "./locations.js";

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

describe("upsertMarkedBlock", () => {
  const block = codexBlock();

  test("appends to existing user content, preserving it", () => {
    const out = upsertMarkedBlock("# My rules\n\nBe terse.\n", block, CODEX_BEGIN, CODEX_END);
    expect(out.startsWith("# My rules\n\nBe terse.\n")).toBe(true);
    expect(out).toContain(CODEX_BEGIN);
    expect(out).toContain(CODEX_END);
  });

  test("replaces an existing block in place; reinstall is a fixpoint", () => {
    const seeded = upsertMarkedBlock("before\n", block, CODEX_BEGIN, CODEX_END) + "after\n";
    const again = upsertMarkedBlock(seeded, block, CODEX_BEGIN, CODEX_END);
    expect(again).toBe(seeded);
    expect(again.split(CODEX_BEGIN)).toHaveLength(2); // exactly one block
    const stale = seeded.replace("otacon wait", "otacon OLD-VERB");
    expect(upsertMarkedBlock(stale, block, CODEX_BEGIN, CODEX_END)).toBe(seeded);
  });

  test("an empty file becomes just the block", () => {
    expect(upsertMarkedBlock("", block, CODEX_BEGIN, CODEX_END)).toBe(`${block}\n`);
  });
});

describe("wrapper assets", () => {
  test("the protocol card carries every load-bearing command", () => {
    for (const text of [skillMd(), codexBlock()]) {
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
        // Visuals guidance (DESIGN.md §4): the three primitives + soft SHOULDs.
        "## Visuals",
        "[!risk]",
        "SHOULD use a matrix",
        "[new]",
      ]) {
        expect(text).toContain(needle);
      }
    }
    expect(skillMd().startsWith("---\nname: otacon\n")).toBe(true);
  });

  test("the Stop hook script is plain sh, fail-open, and emits the block decision", () => {
    expect(STOP_HOOK_SCRIPT.startsWith("#!/bin/sh\n")).toBe(true);
    expect(STOP_HOOK_SCRIPT).toContain('"decision":"block"');
    expect(STOP_HOOK_SCRIPT).toContain("exit 0");
    // It drops ALL terminal statuses so a finished build no longer traps the
    // agent, while an in-flight `implementing` session still blocks the stop.
    expect(STOP_HOOK_SCRIPT).toContain(
      `grep -vE '"status":"(approved|implemented|implement_failed)"'`,
    );
  });
});
