import { describe, expect, test } from "bun:test";
import { createDesktopNotifier } from "./desktop-notify.js";
import type { SpawnFn } from "./desktop-notify.js";

/** A recorder spawn: captures (bin, args) instead of firing a real banner. */
function recorder(): { calls: { bin: string; args: string[] }[]; spawn: SpawnFn } {
  const calls: { bin: string; args: string[] }[] = [];
  return { calls, spawn: (bin, args) => calls.push({ bin, args }) };
}

describe("createDesktopNotifier", () => {
  test("prefers terminal-notifier and passes -open for click-to-review", () => {
    const { calls, spawn } = recorder();
    const notify = createDesktopNotifier({
      platform: "darwin",
      findNotifier: () => "/usr/local/bin/terminal-notifier",
      spawn,
    });
    notify({ title: "auth-refactor", message: "Revision r2 ready for review", url: "http://127.0.0.1:4747/s/otc_a1b2c3" });
    expect(calls).toEqual([
      {
        bin: "/usr/local/bin/terminal-notifier",
        args: [
          "-title",
          "auth-refactor",
          "-message",
          "Revision r2 ready for review",
          "-open",
          "http://127.0.0.1:4747/s/otc_a1b2c3",
        ],
      },
    ]);
  });

  test("terminal-notifier without a url omits -open", () => {
    const { calls, spawn } = recorder();
    const notify = createDesktopNotifier({
      platform: "darwin",
      findNotifier: () => "terminal-notifier",
      spawn,
    });
    notify({ title: "t", message: "m" });
    expect(calls[0]).toEqual({ bin: "terminal-notifier", args: ["-title", "t", "-message", "m"] });
  });

  test("falls back to osascript when terminal-notifier is absent", () => {
    const { calls, spawn } = recorder();
    const notify = createDesktopNotifier({
      platform: "darwin",
      findNotifier: () => undefined,
      spawn,
    });
    notify({ title: "auth-refactor", message: "2 questions need your answer", url: "ignored" });
    expect(calls).toEqual([
      {
        bin: "osascript",
        args: [
          "-e",
          'display notification "2 questions need your answer" with title "auth-refactor"',
        ],
      },
    ]);
  });

  test("escapes quotes and backslashes into the AppleScript literal", () => {
    const { calls, spawn } = recorder();
    const notify = createDesktopNotifier({
      platform: "darwin",
      findNotifier: () => undefined,
      spawn,
    });
    // A title/message lifted verbatim from a question — quotes and a backslash.
    notify({ title: 'say "hi"', message: "a\\b \"c\"" });
    expect(calls[0]?.bin).toBe("osascript");
    expect(calls[0]?.args[1]).toBe(
      'display notification "a\\\\b \\"c\\"" with title "say \\"hi\\""',
    );
  });

  test("the arg array goes through no shell — terminal-notifier never quotes", () => {
    const { calls, spawn } = recorder();
    const notify = createDesktopNotifier({
      platform: "darwin",
      findNotifier: () => "terminal-notifier",
      spawn,
    });
    // Injection-shaped text rides as one inert argv element, not a parsed command.
    notify({ title: "t", message: '"; rm -rf / #', url: "http://x" });
    expect(calls[0]?.args).toContain('"; rm -rf / #');
  });

  test("no-op off macOS — never spawns", () => {
    const { calls, spawn } = recorder();
    const notify = createDesktopNotifier({
      platform: "linux",
      findNotifier: () => "terminal-notifier",
      spawn,
    });
    notify({ title: "t", message: "m", url: "http://x" });
    expect(calls).toEqual([]);
  });
});
