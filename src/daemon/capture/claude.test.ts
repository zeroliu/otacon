import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { __test, claudeAdapter } from "./claude.js";
import type { Cursor, TranscriptHandle } from "./adapter.js";
import { INITIAL_CURSOR } from "./adapter.js";

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/claude-transcript.jsonl", import.meta.url));

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otacon-claude-"));
  path = join(dir, "transcript.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const handle = (p: string): TranscriptHandle => ({ agent: "claude", path: p });

describe("parse: the synthetic fixture from offset 0", () => {
  test("yields thinking, Read, then Bash (plus the tool_result outcomes), in order", () => {
    const body = readFileSync(FIXTURE, "utf8");
    writeFileSync(path, body);
    const { events } = claudeAdapter.parse(handle(path), { ...INITIAL_CURSOR, repoRoot: "/repo" });

    // The user prompt text, the thinking block, the Read, its result, an
    // assistant text, the Bash, and its result — in transcript order.
    const kinds = events.map((e) => `${e.kind}:${e.status ?? ""}`);
    expect(events.map((e) => e.label)).toEqual([
      "Add a retry to the fetch helper.",
      "thinking…",
      "Read src/fetch.ts",
      "→ ok",
      "I'll run the tests to confirm the baseline before editing.",
      "Bash: bun test src/fetch.test.ts",
      "→ ok",
    ]);
    // The three required block types are present and correctly shaped.
    const thinking = events.find((e) => e.kind === "thinking");
    expect(thinking?.detail).toContain("read the fetch helper");
    const read = events.find((e) => e.label === "Read src/fetch.ts");
    expect(read).toMatchObject({ kind: "tool", tool: "Read", status: "running" });
    const bash = events.find((e) => e.label.startsWith("Bash:"));
    expect(bash).toMatchObject({ kind: "tool", tool: "Bash", status: "running" });
    expect(kinds).toContain("tool:ok");
  });

  test("a Read path is made repo-relative against the recorded cwd", () => {
    writeFileSync(path, readFileSync(FIXTURE, "utf8"));
    // No repoRoot on the cursor → it falls back to the transcript's recorded cwd.
    const { events } = claudeAdapter.parse(handle(path), { ...INITIAL_CURSOR });
    expect(events.some((e) => e.label === "Read src/fetch.ts")).toBe(true);
  });
});

describe("parse: incremental cursor + partial lines", () => {
  test("a second parse does not replay already-consumed lines", () => {
    writeFileSync(path, readFileSync(FIXTURE, "utf8"));
    const first = claudeAdapter.parse(handle(path), { ...INITIAL_CURSOR, repoRoot: "/repo" });
    expect(first.events.length).toBeGreaterThan(0);
    const second = claudeAdapter.parse(handle(path), first.cursor);
    expect(second.events).toEqual([]);
    expect(second.cursor.offset).toBe(first.cursor.offset);
  });

  test("a trailing partial line is not consumed until completed", () => {
    const line = (o: object) => JSON.stringify(o) + "\n";
    const a = line({ type: "assistant", cwd: "/repo", message: { role: "assistant", content: [{ type: "text", text: "first" }] } });
    writeFileSync(path, a);
    // A complete line, then a partial (no trailing newline yet).
    const partial = '{"type":"assistant","cwd":"/repo","message":{"role":"assistant","content":[{"type":"text","text":"sec';
    appendFileSync(path, partial);

    const first = claudeAdapter.parse(handle(path), { ...INITIAL_CURSOR, repoRoot: "/repo" });
    expect(first.events.map((e) => e.label)).toEqual(["first"]);
    // Offset left BEFORE the partial line (= length of the first complete line).
    expect(first.cursor.offset).toBe(Buffer.byteLength(a, "utf8"));

    // The partial completes; the next parse picks it up with no replay.
    appendFileSync(path, 'ond"}]}}\n');
    const second = claudeAdapter.parse(handle(path), first.cursor);
    expect(second.events.map((e) => e.label)).toEqual(["second"]);
  });

  test("a corrupt line is skipped, not thrown", () => {
    const good = JSON.stringify({ type: "assistant", cwd: "/repo", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\n";
    writeFileSync(path, "{ this is not json\n" + good);
    const { events } = claudeAdapter.parse(handle(path), { ...INITIAL_CURSOR, repoRoot: "/repo" });
    expect(events.map((e) => e.label)).toEqual(["ok"]);
  });

  test("a vanished file is fail-soft (no events, cursor preserved)", () => {
    const { events, cursor } = claudeAdapter.parse(handle(join(dir, "nope.jsonl")), { offset: 42 });
    expect(events).toEqual([]);
    expect(cursor.offset).toBe(42);
  });

  test("a truncated/rotated file resets the offset to 0", () => {
    writeFileSync(path, "short\n");
    const { cursor } = claudeAdapter.parse(handle(path), { offset: 9999 });
    expect(cursor.offset).toBe(0);
  });

  test("a multibyte line advances the offset by bytes, not chars", () => {
    const text = "café ☕ resumé"; // multibyte content
    const ln = JSON.stringify({ type: "assistant", cwd: "/repo", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
    writeFileSync(path, ln);
    const { cursor } = claudeAdapter.parse(handle(path), { ...INITIAL_CURSOR, repoRoot: "/repo" });
    expect(cursor.offset).toBe(Buffer.byteLength(ln, "utf8"));
  });
});

describe("locate", () => {
  test("returns null when no transcript dir exists for the repo", () => {
    expect(claudeAdapter.locate(join(dir, "no-such-repo"))).toBeNull();
  });

  test("finds the freshest .jsonl whose recorded cwd matches", () => {
    // Stand up a fake ~/.claude/projects layout under a temp HOME.
    const home = mkdtempSync(join(tmpdir(), "otacon-home-"));
    const repoRoot = "/Users/test/myrepo";
    const projectDir = join(home, ".claude", "projects", repoRoot.replace(/\//g, "-"));
    mkdirSync(projectDir, { recursive: true });
    const stale = join(projectDir, "stale.jsonl");
    const fresh = join(projectDir, "fresh.jsonl");
    writeFileSync(stale, JSON.stringify({ type: "user", cwd: repoRoot }) + "\n");
    writeFileSync(fresh, JSON.stringify({ type: "user", cwd: repoRoot }) + "\n");
    // Make `fresh` newer.
    const now = Date.now();
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    utimesSync(stale, new Date(now - 10000), new Date(now - 10000));
    utimesSync(fresh, new Date(now), new Date(now));

    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const located = claudeAdapter.locate(repoRoot);
      expect(located?.path).toBe(fresh);
      expect(located?.agent).toBe("claude");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("returns null when a transcript's recorded cwd is a different repo", () => {
    const home = mkdtempSync(join(tmpdir(), "otacon-home-"));
    const repoRoot = "/Users/test/myrepo";
    const projectDir = join(home, ".claude", "projects", repoRoot.replace(/\//g, "-"));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "other.jsonl"), JSON.stringify({ type: "user", cwd: "/some/other/repo" }) + "\n");
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(claudeAdapter.locate(repoRoot)).toBeNull();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("pure mappers", () => {
  test("toolLabel: concise labels per tool", () => {
    const repo = "/repo";
    expect(__test.toolLabel("Read", { file_path: "/repo/a/b.ts" }, repo)).toBe("Read a/b.ts");
    expect(__test.toolLabel("Edit", { file_path: "/repo/c.ts" }, repo)).toBe("Edit c.ts");
    expect(__test.toolLabel("Write", { file_path: "/repo/d.ts" }, repo)).toBe("Write d.ts");
    expect(__test.toolLabel("Bash", { command: "ls -la" }, repo)).toBe("Bash: ls -la");
    expect(__test.toolLabel("Grep", { pattern: "TODO" }, repo)).toBe("Grep TODO");
    expect(__test.toolLabel("Glob", { pattern: "**/*.ts" }, repo)).toBe("Glob **/*.ts");
    expect(__test.toolLabel("Task", { description: "do a thing" }, repo)).toBe("Task: do a thing");
    expect(__test.toolLabel("WeirdCustomTool", {}, repo)).toBe("WeirdCustomTool");
  });

  test("toolLabel: Bash truncates a long command", () => {
    const long = "x".repeat(200);
    const label = __test.toolLabel("Bash", { command: long }, "/repo");
    expect(label.length).toBeLessThan(90);
    expect(label.endsWith("…")).toBe(true);
  });

  test("relPath: absolute path outside the repo stays absolute", () => {
    expect(__test.relPath("/elsewhere/x.ts", "/repo")).toBe("/elsewhere/x.ts");
    expect(__test.relPath("/repo/inside.ts", "/repo")).toBe("inside.ts");
    expect(__test.relPath("already/rel.ts", "/repo")).toBe("already/rel.ts");
  });

  test("resultText: string and array-of-text-blocks both flatten", () => {
    expect(__test.resultText("plain")).toBe("plain");
    expect(__test.resultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(__test.resultText(undefined)).toBe("");
  });

  test("lineToEvents: a long text block clamps its label with an ellipsis", () => {
    const text = "x".repeat(200);
    const line = { message: { role: "assistant", content: [{ type: "text", text }] } };
    const [event] = __test.lineToEvents(line, "/repo");
    expect(event?.kind).toBe("text");
    expect(event?.label.length).toBeLessThan(90);
    expect(event?.label.endsWith("…")).toBe(true);
    expect(event?.detail).toBe(text); // full text stays on detail
  });

  test("lineToEvents: an error tool_result maps to status error", () => {
    const line = { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "boom", is_error: true }] } };
    const [event] = __test.lineToEvents(line, "/repo");
    expect(event).toMatchObject({ kind: "tool", status: "error", label: "→ error", detail: "boom" });
  });

  test("lineToEvents: system/summary lines yield nothing", () => {
    expect(__test.lineToEvents({ type: "system", message: undefined }, "/repo")).toEqual([]);
    expect(__test.lineToEvents({ type: "summary" }, "/repo")).toEqual([]);
  });
});
