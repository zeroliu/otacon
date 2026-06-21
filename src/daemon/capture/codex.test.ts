import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { __test, codexAdapter } from "./codex.js";
import type { TranscriptHandle } from "./adapter.js";
import { INITIAL_CURSOR } from "./adapter.js";

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/codex-rollout.jsonl", import.meta.url));

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otacon-codex-"));
  path = join(dir, "rollout.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const handle = (p: string): TranscriptHandle => ({ agent: "codex", path: p });

describe("parse: the synthetic rollout from offset 0", () => {
  test("yields thinking, a tool named for the call, its outcome, then assistant text — in order", () => {
    writeFileSync(path, readFileSync(FIXTURE, "utf8"));
    const { events } = codexAdapter.parse(handle(path), { ...INITIAL_CURSOR, repoRoot: "/repo" });

    // The user prompt and event_msg records are skipped; the reasoning →
    // thinking, the function_call → a tool, its function_call_output → an
    // outcome, and the assistant message → text, in record order.
    expect(events.map((e) => e.label)).toEqual([
      "thinking…",
      "Bash: bun test src/fetch.test.ts",
      "→ ok",
      "The baseline tests pass. I'll add the retry wrapper next.",
    ]);

    // The behavioral assertion: a reasoning item yields a thinking event, and a
    // function_call yields a tool event named for the call.
    const thinking = events.find((e) => e.kind === "thinking");
    expect(thinking?.detail).toContain("read the fetch helper");
    const tool = events.find((e) => e.kind === "tool" && e.status === "running");
    expect(tool).toMatchObject({ kind: "tool", tool: "exec_command", status: "running" });
    expect(tool?.label).toBe("Bash: bun test src/fetch.test.ts");
    expect(tool?.detail).toContain("bun test");

    // The outcome is a SEPARATE appended event (append-only), not a mutation.
    const outcome = events.find((e) => e.label === "→ ok");
    expect(outcome).toMatchObject({ kind: "tool", status: "ok" });
    expect(outcome?.detail).toContain("1 pass");
  });
});

describe("parse: incremental cursor + partial lines", () => {
  test("a second parse does not replay already-consumed lines", () => {
    writeFileSync(path, readFileSync(FIXTURE, "utf8"));
    const first = codexAdapter.parse(handle(path), { ...INITIAL_CURSOR, repoRoot: "/repo" });
    expect(first.events.length).toBeGreaterThan(0);
    const second = codexAdapter.parse(handle(path), first.cursor);
    expect(second.events).toEqual([]);
    expect(second.cursor.offset).toBe(first.cursor.offset);
  });

  test("a trailing partial line is not consumed until completed", () => {
    const env = (o: object) => JSON.stringify({ type: "response_item", payload: o }) + "\n";
    const a = env({ type: "message", role: "assistant", content: [{ type: "output_text", text: "first" }] });
    writeFileSync(path, a);
    // A complete line, then a partial (no trailing newline yet).
    const partial = '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"sec';
    appendFileSync(path, partial);

    const first = codexAdapter.parse(handle(path), { ...INITIAL_CURSOR, repoRoot: "/repo" });
    expect(first.events.map((e) => e.label)).toEqual(["first"]);
    // Offset left BEFORE the partial line (= byte length of the first complete line).
    expect(first.cursor.offset).toBe(Buffer.byteLength(a, "utf8"));

    // The partial completes; the next parse picks it up with no replay.
    appendFileSync(path, 'ond"}]}}\n');
    const second = codexAdapter.parse(handle(path), first.cursor);
    expect(second.events.map((e) => e.label)).toEqual(["second"]);
  });

  test("a corrupt line is skipped, not thrown", () => {
    const good = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } }) + "\n";
    writeFileSync(path, "{ this is not json\n" + good);
    const { events } = codexAdapter.parse(handle(path), { ...INITIAL_CURSOR, repoRoot: "/repo" });
    expect(events.map((e) => e.label)).toEqual(["ok"]);
  });

  test("a vanished file is fail-soft (no events, cursor preserved)", () => {
    const { events, cursor } = codexAdapter.parse(handle(join(dir, "nope.jsonl")), { offset: 42 });
    expect(events).toEqual([]);
    expect(cursor.offset).toBe(42);
  });

  test("a truncated/rotated file resets the offset to 0", () => {
    writeFileSync(path, "short\n");
    const { cursor } = codexAdapter.parse(handle(path), { offset: 9999 });
    expect(cursor.offset).toBe(0);
  });

  test("a multibyte line advances the offset by bytes, not chars", () => {
    const text = "café ☕ resumé"; // multibyte content
    const ln = JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }) + "\n";
    writeFileSync(path, ln);
    const { cursor } = codexAdapter.parse(handle(path), { ...INITIAL_CURSOR, repoRoot: "/repo" });
    expect(cursor.offset).toBe(Buffer.byteLength(ln, "utf8"));
  });
});

describe("locate", () => {
  /** Stand up a fake `$CODEX_HOME/sessions/<y>/<m>/<d>/` rollout. */
  function writeRollout(home: string, ymd: [string, string, string], name: string, cwd: string): string {
    const day = join(home, "sessions", ...ymd);
    mkdirSync(day, { recursive: true });
    const p = join(day, name);
    writeFileSync(p, JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n");
    return p;
  }

  function withCodexHome(home: string, fn: () => void): void {
    const prevCodexHome = process.env.CODEX_HOME;
    const prevHome = process.env.HOME;
    process.env.CODEX_HOME = home;
    try {
      fn();
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  }

  test("returns null when no sessions tree exists", () => {
    const home = mkdtempSync(join(tmpdir(), "otacon-codexhome-"));
    withCodexHome(home, () => {
      expect(codexAdapter.locate("/Users/test/myrepo")).toBeNull();
    });
    rmSync(home, { recursive: true, force: true });
  });

  test("finds the freshest rollout whose session_meta cwd matches", () => {
    const home = mkdtempSync(join(tmpdir(), "otacon-codexhome-"));
    const repoRoot = "/Users/test/myrepo";
    const stale = writeRollout(home, ["2026", "06", "20"], "rollout-2026-06-20T00-00-00-aaaa.jsonl", repoRoot);
    const fresh = writeRollout(home, ["2026", "06", "21"], "rollout-2026-06-21T00-00-00-bbbb.jsonl", repoRoot);
    // Make `fresh` newer (locate sorts by mtime, not by path/date layout).
    const now = Date.now();
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    utimesSync(stale, new Date(now - 10000), new Date(now - 10000));
    utimesSync(fresh, new Date(now), new Date(now));

    withCodexHome(home, () => {
      const located = codexAdapter.locate(repoRoot);
      expect(located?.path).toBe(fresh);
      expect(located?.agent).toBe("codex");
    });
    rmSync(home, { recursive: true, force: true });
  });

  test("rejects a rollout whose session_meta cwd is a different repo", () => {
    const home = mkdtempSync(join(tmpdir(), "otacon-codexhome-"));
    const repoRoot = "/Users/test/myrepo";
    writeRollout(home, ["2026", "06", "21"], "rollout-2026-06-21T00-00-00-cccc.jsonl", "/some/other/repo");
    withCodexHome(home, () => {
      expect(codexAdapter.locate(repoRoot)).toBeNull();
    });
    rmSync(home, { recursive: true, force: true });
  });
});

describe("pure mappers", () => {
  test("toolLabel: shell tools surface the command; apply_patch surfaces the file", () => {
    const repo = "/repo";
    expect(__test.toolLabel("exec_command", { cmd: "git status" }, "", repo)).toBe("Bash: git status");
    // Older OpenAI `shell` form with a `bash -lc <script>` array.
    expect(__test.toolLabel("shell", { command: ["bash", "-lc", "bun test"] }, "", repo)).toBe("Bash: bun test");
    expect(__test.toolLabel("shell", { command: ["ls", "-la"] }, "", repo)).toBe("Bash: ls -la");
    // apply_patch with a structured path and with a heredoc body.
    expect(__test.toolLabel("apply_patch", { path: "/repo/a/b.ts" }, "", repo)).toBe("Edit a/b.ts");
    expect(__test.toolLabel("apply_patch", {}, "*** Update File: src/x.ts\n@@\n-old\n+new", repo)).toBe("Edit src/x.ts");
    expect(__test.toolLabel("apply_patch", {}, "no file marker here", repo)).toBe("apply_patch");
    // Unknown tool → its own name.
    expect(__test.toolLabel("update_plan", {}, "", repo)).toBe("update_plan");
  });

  test("toolLabel: a long shell command is clamped with an ellipsis", () => {
    const long = "echo " + "x".repeat(200);
    const label = __test.toolLabel("exec_command", { cmd: long }, "", "/repo");
    expect(label.length).toBeLessThan(90);
    expect(label.endsWith("…")).toBe(true);
  });

  test("shellCommand: handles string cmd, command array, and bash -lc script", () => {
    expect(__test.shellCommand({ cmd: "git log" })).toBe("git log");
    expect(__test.shellCommand({ command: "git log" })).toBe("git log");
    expect(__test.shellCommand({ command: ["bash", "-lc", "make build"] })).toBe("make build");
    expect(__test.shellCommand({ command: ["echo", "hi"] })).toBe("echo hi");
    expect(__test.shellCommand({})).toBe("");
  });

  test("reasoningText: flattens a summary array, empty when only encrypted", () => {
    expect(__test.reasoningText({ summary: [{ type: "summary_text", text: "a" }, { type: "summary_text", text: "b" }] })).toBe("a\nb");
    expect(__test.reasoningText({ summary: [], encrypted_content: "<opaque>" })).toBe("");
  });

  test("messageText: flattens content blocks and plain string content", () => {
    expect(__test.messageText({ content: [{ type: "output_text", text: "hello" }] })).toBe("hello");
    expect(__test.messageText({ content: "plain" })).toBe("plain");
    expect(__test.messageText({ content: undefined })).toBe("");
  });

  test("outputIsError: plain text is ok; JSON with a non-zero exit or success:false is error", () => {
    expect(__test.outputIsError("all good")).toBe(false);
    expect(__test.outputIsError('{"exit_code":0,"output":"fine"}')).toBe(false);
    expect(__test.outputIsError('{"exit_code":1,"output":"boom"}')).toBe(true);
    expect(__test.outputIsError('{"metadata":{"exit_code":2}}')).toBe(true);
    expect(__test.outputIsError('{"success":false}')).toBe(true);
    expect(__test.outputIsError("")).toBe(false);
  });

  test("lineToEvents: a user message and non-response_item envelopes yield nothing", () => {
    expect(__test.lineToEvents({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }, "/repo")).toEqual([]);
    expect(__test.lineToEvents({ type: "session_meta", payload: { cwd: "/repo" } }, "/repo")).toEqual([]);
    expect(__test.lineToEvents({ type: "event_msg", payload: { type: "task_started" } }, "/repo")).toEqual([]);
  });

  test("lineToEvents: a function_call_output with a non-zero exit maps to status error", () => {
    const [event] = __test.lineToEvents({ type: "response_item", payload: { type: "function_call_output", call_id: "x", output: '{"exit_code":1,"output":"boom"}' } }, "/repo");
    expect(event).toMatchObject({ kind: "tool", status: "error", label: "→ error" });
    expect(event?.detail).toContain("boom");
  });
});
