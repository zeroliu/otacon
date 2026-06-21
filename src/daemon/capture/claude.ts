// The Claude Code transcript adapter. Claude writes a JSONL transcript per
// session under `~/.claude/projects/<dash-encoded-abs-cwd>/<uuid>.jsonl`, where
// the encoded dir is the absolute cwd with every `/` replaced by `-`. Each line
// is a JSON object; the ones we care about carry `type`
// ("user"|"assistant"|...), `cwd`, `timestamp`, `isSidechain`, and `message`
// (an Anthropic message with `role` + `content[]`).
//
// `locate` finds the freshest `.jsonl` in the encoded projects dir whose
// recorded `cwd` equals the session's repo root (the encoding already implies
// cwd, but a recorded cwd line confirms it and tolerates collisions). `parse`
// reads new BYTES since the cursor offset, splits off only COMPLETE lines
// (leaving a trailing partial for the next poll), and maps each recognized
// block to a `RawStreamEvent`. Everything is fail-soft: an unreadable file, a
// torn line, or an unexpected shape is skipped, never thrown — the worst case
// is the session running on the `otacon progress` floor.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Cursor, RawStreamEvent, TranscriptAdapter, TranscriptHandle } from "./adapter.js";

const AGENT = "claude";

/** `~/.claude/projects` — where Claude Code keeps per-cwd transcript dirs. */
function projectsRoot(): string {
  // Prefer $HOME (the standard override; what a test or a custom-home user
  // expects) and fall back to os.homedir() — Bun's homedir() ignores $HOME.
  const home = process.env.HOME && process.env.HOME !== "" ? process.env.HOME : homedir();
  return join(home, ".claude", "projects");
}

/**
 * Claude's dir encoding: the absolute cwd with every `/` replaced by `-`. This
 * is lossy (a literal `-` in a path is indistinguishable from a separator), so
 * `locate` confirms against the transcript's recorded `cwd` rather than trusting
 * the encoding alone.
 */
function encodeProjectDir(repoRoot: string): string {
  return repoRoot.replace(/\//g, "-");
}

/** First non-blank JSON line's `cwd`, or undefined (empty/corrupt/no cwd). */
function recordedCwd(path: string): string | undefined {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const cwd = (JSON.parse(trimmed) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string") return cwd;
    } catch {
      // skip a corrupt line and keep looking for a parseable cwd
    }
  }
  return undefined;
}

/**
 * The freshest transcript whose recorded cwd equals `repoRoot`. We scan the
 * encoded projects dir newest-first (by mtime) and return the first `.jsonl`
 * whose first line's `cwd` matches; null when the dir is missing or no file
 * matches. Never throws.
 */
function locate(repoRoot: string): TranscriptHandle | null {
  const dir = join(projectsRoot(), encodeProjectDir(repoRoot));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null; // no transcript dir for this repo yet
  }
  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      candidates.push({ path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      // file vanished between readdir and stat — skip it
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { path } of candidates) {
    if (recordedCwd(path) === repoRoot) return { agent: AGENT, path };
  }
  return null;
}

/** A transcript line we recognize enough to act on; everything else is skipped. */
interface TranscriptLine {
  type?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

const TOOL_LABEL_MAX = 80;

/** First line of `text`, trimmed; the one-line label for a text/result body. */
function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

/** Make `p` repo-relative when it sits under `repoRoot`; else return it as-is. */
function relPath(p: string, repoRoot: string): string {
  if (typeof p !== "string" || p === "") return String(p ?? "");
  if (!isAbsolute(p)) return p;
  const rel = relative(repoRoot, p);
  // `relative` of a path outside the repo starts with ".." or is absolute on a
  // different drive — keep the absolute path then (it is genuinely elsewhere).
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return p;
  return rel.split(sep).join("/");
}

/** Concise label for a tool_use, e.g. "Read src/auth.ts" / "Bash: bun test". */
function toolLabel(name: string, input: Record<string, unknown>, repoRoot: string): string {
  const file = (k: string) => relPath(String(input[k] ?? ""), repoRoot);
  switch (name) {
    case "Read":
      return `Read ${file("file_path")}`;
    case "Edit":
    case "MultiEdit":
      return `Edit ${file("file_path")}`;
    case "Write":
      return `Write ${file("file_path")}`;
    case "Bash": {
      const cmd = String(input.command ?? "");
      const oneLine = firstLine(cmd);
      const shown = oneLine.length > TOOL_LABEL_MAX ? `${oneLine.slice(0, TOOL_LABEL_MAX - 1)}…` : oneLine;
      return `Bash: ${shown}`;
    }
    case "Grep":
      return `Grep ${String(input.pattern ?? "")}`;
    case "Glob":
      return `Glob ${String(input.pattern ?? "")}`;
    case "Task":
    case "Agent":
      return `Task: ${String(input.description ?? "")}`;
    default:
      return name;
  }
}

/** A tool_result's content can be a plain string or an array of text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .filter((t) => t !== "")
      .join("\n");
  }
  return "";
}

/** Map one assistant/user content block to a RawStreamEvent, or null to skip it. */
function blockToEvent(block: ContentBlock, repoRoot: string): RawStreamEvent | null {
  switch (block.type) {
    case "text": {
      const text = typeof block.text === "string" ? block.text : "";
      if (text.trim() === "") return null;
      return { kind: "text", label: firstLine(text).slice(0, TOOL_LABEL_MAX) || "text", detail: text };
    }
    case "thinking": {
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      if (thinking.trim() === "") return null;
      return { kind: "thinking", label: "thinking…", detail: thinking };
    }
    case "tool_use": {
      const name = typeof block.name === "string" ? block.name : "tool";
      const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
      return {
        kind: "tool",
        tool: name,
        label: toolLabel(name, input, repoRoot),
        detail: JSON.stringify(input),
        status: "running",
      };
    }
    case "tool_result": {
      // A follow-on outcome — Phase 1's store is append-only, so we never upsert
      // the running event; we append the result as its own event.
      const isError = block.is_error === true;
      const detail = resultText(block.content);
      return {
        kind: "tool",
        status: isError ? "error" : "ok",
        label: isError ? "→ error" : "→ ok",
        detail: detail === "" ? undefined : detail,
      };
    }
    default:
      return null;
  }
}

/** Every recognized event from one parsed transcript line, in content order. */
function lineToEvents(line: TranscriptLine, repoRoot: string): RawStreamEvent[] {
  // Only assistant/user messages carry the content blocks we map; other line
  // types (system, summary, queue-operation, attachment, …) are skipped.
  const role = line.message?.role;
  if (role !== "assistant" && role !== "user") return [];
  const content = line.message?.content;
  if (!Array.isArray(content)) return [];
  const events: RawStreamEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const event = blockToEvent(block as ContentBlock, repoRoot);
    if (event) events.push(event);
  }
  return events;
}

/**
 * Read new bytes from `cursor.offset` to EOF, consume only COMPLETE lines, and
 * emit their events. A trailing partial line (no terminating newline) is left
 * unconsumed — the offset stays before it so the next poll completes it. The
 * advanced offset is the byte position just past the last complete line. Every
 * step is fail-soft.
 */
function parse(handle: TranscriptHandle, cursor: Cursor): { events: RawStreamEvent[]; cursor: Cursor } {
  const repoRoot = (cursor.repoRoot as string | undefined) ?? recordedCwd(handle.path) ?? "";
  let buffer: Buffer;
  try {
    buffer = readFileSync(handle.path);
  } catch {
    return { events: [], cursor }; // file vanished — leave the cursor put
  }
  const offset = typeof cursor.offset === "number" && cursor.offset >= 0 ? cursor.offset : 0;
  if (offset >= buffer.length) {
    // No new bytes, or the file was truncated/rotated below our offset. When it
    // shrank, reset so we don't read past the end forever (a rare rotation).
    const next = offset > buffer.length ? 0 : offset;
    return { events: [], cursor: { ...cursor, offset: next, repoRoot } };
  }
  const slice = buffer.toString("utf8", offset);
  const lastNl = slice.lastIndexOf("\n");
  if (lastNl === -1) {
    // The whole new chunk is one partial line — consume nothing, wait for more.
    return { events: [], cursor: { ...cursor, offset, repoRoot } };
  }
  const complete = slice.slice(0, lastNl); // excludes the trailing partial
  // Advance by the BYTE length of the consumed text (incl. its final newline),
  // not the char count — multibyte content would otherwise drift the offset.
  const consumedBytes = Buffer.byteLength(complete, "utf8") + 1;
  const events: RawStreamEvent[] = [];
  for (const raw of complete.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(trimmed) as TranscriptLine;
    } catch {
      continue; // skip a corrupt line, keep going
    }
    for (const event of lineToEvents(parsed, repoRoot)) events.push(event);
  }
  return { events, cursor: { ...cursor, offset: offset + consumedBytes, repoRoot } };
}

/** The Claude Code transcript adapter (read-only, fail-soft). */
export const claudeAdapter: TranscriptAdapter = {
  agent: AGENT,
  locate,
  parse,
};

// Test-only exports — the pure mappers are worth covering directly.
export const __test = { toolLabel, relPath, resultText, lineToEvents, encodeProjectDir };
