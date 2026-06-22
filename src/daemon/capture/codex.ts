// The Codex CLI transcript adapter. Codex writes a per-session "rollout" JSONL
// under `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`
// (`$CODEX_HOME` overrides `~/.codex`). Each line is a JSON envelope
// `{ timestamp, type, payload }`. A leading `type:"session_meta"` record carries
// the session `cwd` (used by `locate`). Subsequent `type:"response_item"`
// records wrap the items we map: `reasoning` (model thinking),
// `message` (role assistant/user with content blocks), `function_call`
// (tool invocation with `name` + `arguments` JSON string + `call_id`), and
// `function_call_output` (the tool outcome). `event_msg`/`turn_context` and any
// payload we don't recognize are skipped.
//
// `locate` scans every rollout under the sessions tree (CODEX_HOME-aware),
// newest-first by mtime, and returns the first whose `session_meta.cwd` equals
// the repo root. `parse` reads new BYTES since the cursor offset, consumes only
// COMPLETE lines (leaving a trailing partial for the next poll), and maps each
// recognized payload to a `RawStreamEvent`. Everything is fail-soft: an
// unreadable file, a torn line, or an unexpected shape is skipped, never thrown
// — the worst case is the session running on the `otacon progress` floor.
//
// Codex versions vary, so the mappers are defensive: the shell tool may be
// `exec_command` (with a string `cmd`) on current builds or the older `shell`
// (with a `command` string array); both are handled. A tool's running event and
// its later outcome are emitted as TWO separate appended events (the store is
// append-only and never upserts).

import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Cursor, RawStreamEvent, TranscriptAdapter, TranscriptHandle } from "./adapter.js";

const AGENT = "codex";

/** `$CODEX_HOME` (if set) else `~/.codex` — Codex's home dir. */
function codexHome(): string {
  const override = process.env.CODEX_HOME;
  if (typeof override === "string" && override !== "") return override;
  // Prefer $HOME (the standard override; what a test or a custom-home user
  // expects) and fall back to os.homedir() — Bun's homedir() ignores $HOME.
  const home = process.env.HOME && process.env.HOME !== "" ? process.env.HOME : homedir();
  return join(home, ".codex");
}

/** `$CODEX_HOME/sessions` — the date-partitioned rollout tree. */
function sessionsRoot(): string {
  return join(codexHome(), "sessions");
}

/**
 * Recursively collect every `rollout-*.jsonl` under `dir`, with its mtime. The
 * tree is partitioned `<YYYY>/<MM>/<DD>/`, but we don't trust the layout — we
 * just walk it. Never throws (an unreadable subdir is skipped).
 */
function collectRollouts(dir: string, out: { path: string; mtimeMs: number }[]): void {
  let entries: { name: string; isDir: boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  } catch {
    return; // missing/unreadable dir — skip it
  }
  for (const { name, isDir } of entries) {
    const path = join(dir, name);
    if (isDir) {
      collectRollouts(path, out);
      continue;
    }
    if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
    try {
      out.push({ path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      // file vanished between readdir and stat — skip it
    }
  }
}

/** A rollout envelope line we recognize enough to act on. */
interface Envelope {
  type?: string;
  payload?: Record<string, unknown>;
}

// `locate` reads only enough of each candidate to find the leading
// `session_meta` record — never the whole rollout. The meta is the first line;
// real rollouts top out around 27 KB for that line, so a 64 KB prefix covers it
// with headroom while keeping discovery cheap on a tree of 100s of multi-MB
// rollouts (the worst non-matching case would otherwise read every byte).
const META_PREFIX_BYTES = 64 * 1024;

/** Read up to `max` bytes from the start of `path` as UTF-8, or "" on error. */
function readPrefix(path: string, max: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(max);
    const read = readSync(fd, buf, 0, max, 0);
    return buf.toString("utf8", 0, read);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close — never throw out of a fail-soft locate
      }
    }
  }
}

/**
 * The session `cwd` from a rollout's `session_meta` record (the meta is the
 * first record, but we scan forward to tolerate a leading torn/other line).
 * Reads only a bounded prefix — the meta is the leading line, so we never pull
 * the whole (potentially multi-MB) rollout into memory just to discover its cwd.
 * Returns undefined when the prefix is empty/corrupt or has no meta cwd.
 */
function sessionCwd(path: string): string | undefined {
  const prefix = readPrefix(path, META_PREFIX_BYTES);
  if (prefix === "") return undefined;
  // Drop a trailing partial line: if the meta didn't fit in the prefix we'd
  // rather miss it (and skip the candidate) than parse a truncated record.
  const lastNl = prefix.lastIndexOf("\n");
  const scannable = lastNl === -1 ? prefix : prefix.slice(0, lastNl);
  for (const line of scannable.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let env: Envelope;
    try {
      env = JSON.parse(trimmed) as Envelope;
    } catch {
      continue; // skip a corrupt line, keep looking for the meta
    }
    if (env.type === "session_meta") {
      const cwd = env.payload?.cwd;
      return typeof cwd === "string" ? cwd : undefined;
    }
  }
  return undefined;
}

/**
 * The freshest rollout whose `session_meta.cwd` equals `repoRoot`. We walk the
 * sessions tree, sort newest-first by mtime, and return the first match; null
 * when the tree is missing or no rollout matches. Never throws.
 */
function locate(repoRoot: string): TranscriptHandle | null {
  const candidates: { path: string; mtimeMs: number }[] = [];
  collectRollouts(sessionsRoot(), candidates);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { path } of candidates) {
    if (sessionCwd(path) === repoRoot) return { agent: AGENT, path };
  }
  return null;
}

const TOOL_LABEL_MAX = 80;

/** First line of `text`, trimmed; the one-line label for a text/reasoning body. */
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

/** Cap a one-line command/string to the label width with a trailing ellipsis. */
function clamp(text: string): string {
  const oneLine = firstLine(text);
  return oneLine.length > TOOL_LABEL_MAX ? `${oneLine.slice(0, TOOL_LABEL_MAX - 1)}…` : oneLine;
}

/**
 * Pull a human shell command out of a tool's parsed arguments. Codex shells
 * appear in a few shapes across versions:
 *   - `{ cmd: "git status" }`              (current `exec_command`)
 *   - `{ command: ["bash","-lc","…"] }`    (older OpenAI `shell`)
 *   - `{ command: "git status" }`          (string fallback)
 * For the `bash -lc <script>` form we surface the script, not the wrapper.
 */
function shellCommand(args: Record<string, unknown>): string {
  const cmd = args.cmd ?? args.command;
  if (typeof cmd === "string") return cmd;
  if (Array.isArray(cmd)) {
    const parts = cmd.map((c) => (typeof c === "string" ? c : String(c)));
    // `bash -lc "<script>"` / `sh -c "<script>"` → show the script itself.
    const flagIdx = parts.findIndex((p) => p === "-lc" || p === "-c" || p === "-lic");
    const script = flagIdx === -1 ? undefined : parts[flagIdx + 1];
    if (script !== undefined) return script;
    return parts.join(" ");
  }
  return "";
}

/** A recoverable file path from an `apply_patch` argument, or "" if none. */
function patchPath(args: Record<string, unknown>, raw: string): string {
  // Structured form: `{ path: "src/x.ts" }` or `{ file_path: "…" }`.
  for (const k of ["path", "file_path", "filename"]) {
    const v = args[k];
    if (typeof v === "string" && v !== "") return v;
  }
  // Heredoc form: `*** Update File: src/x.ts` / `*** Add File: …` inside the
  // patch body, which may be a string field or the raw arguments themselves.
  const body = typeof args.input === "string" ? args.input : typeof args.patch === "string" ? args.patch : raw;
  const m = /\*\*\* (?:Add|Update|Delete) File: (.+)/.exec(body);
  const captured = m?.[1];
  return captured ? captured.trim() : "";
}

const SHELL_TOOLS = new Set(["exec_command", "shell", "local_shell", "exec", "bash", "container.exec"]);

/** Concise label for a function_call, e.g. "Bash: git status" / "Edit src/x.ts". */
function toolLabel(name: string, args: Record<string, unknown>, rawArgs: string, repoRoot: string): string {
  if (SHELL_TOOLS.has(name)) {
    const cmd = shellCommand(args);
    return cmd === "" ? "Bash" : `Bash: ${clamp(cmd)}`;
  }
  if (name === "apply_patch" || name === "edit_file" || name === "str_replace_editor") {
    const file = patchPath(args, rawArgs);
    return file === "" ? "apply_patch" : `Edit ${relPath(file, repoRoot)}`;
  }
  return name;
}

/**
 * Flatten a reasoning payload's `summary` (list of `{ type, text }`) into one
 * string. Newer Codex builds keep the plaintext in `summary`; the
 * `encrypted_content`-only case yields "" (nothing to show — skipped upstream).
 */
function reasoningText(payload: Record<string, unknown>): string {
  const summary = payload.summary;
  if (Array.isArray(summary)) {
    const parts = summary
      .map((s) => (s && typeof s === "object" && typeof (s as { text?: unknown }).text === "string" ? (s as { text: string }).text : ""))
      .filter((t) => t !== "");
    if (parts.length > 0) return parts.join("\n");
  }
  // Some builds carry plaintext directly on `content` / `text`.
  if (typeof payload.content === "string") return payload.content;
  if (typeof payload.text === "string") return payload.text;
  return "";
}

/** Flatten a message payload's `content` (list of `{ type, text }`) to text. */
function messageText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .filter((t) => t !== "")
      .join("\n");
  }
  return "";
}

/**
 * Whether a function_call_output signals an error. The output is usually plain
 * text, but some tools emit a JSON object carrying an exit code / metadata; a
 * non-zero `exit_code`/`exitCode`, or an explicit `success:false`, is an error.
 * Default (plain text, or no metadata) is "ok".
 */
function outputIsError(output: string): boolean {
  const trimmed = output.trim();
  if (trimmed === "" || (trimmed[0] !== "{" && trimmed[0] !== "[")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  const meta = (obj.metadata && typeof obj.metadata === "object" ? (obj.metadata as Record<string, unknown>) : obj);
  const code = meta.exit_code ?? meta.exitCode ?? meta.exit ?? obj.exit_code ?? obj.exitCode;
  if (typeof code === "number" && code !== 0) return true;
  if (obj.success === false || meta.success === false) return true;
  return false;
}

/** Map one `response_item` payload to a RawStreamEvent, or null to skip it. */
function payloadToEvent(payload: Record<string, unknown>, repoRoot: string): RawStreamEvent | null {
  switch (payload.type) {
    case "reasoning": {
      const text = reasoningText(payload);
      if (text.trim() === "") return null; // encrypted-only reasoning → nothing to show
      return { kind: "thinking", label: "thinking…", detail: text };
    }
    case "message": {
      // Skip user prompts the way Claude keeps only model output meaningful here;
      // an assistant message is the model's text.
      if (payload.role !== "assistant") return null;
      const text = messageText(payload);
      if (text.trim() === "") return null;
      return { kind: "text", label: clamp(text) || "text", detail: text };
    }
    case "function_call":
    case "custom_tool_call": {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const rawArgs = typeof payload.arguments === "string" ? payload.arguments : typeof payload.input === "string" ? payload.input : "";
      let args: Record<string, unknown> = {};
      try {
        const a = JSON.parse(rawArgs);
        if (a && typeof a === "object") args = a as Record<string, unknown>;
      } catch {
        // unparseable arguments → label by tool name, detail is the raw string
      }
      return {
        kind: "tool",
        tool: name,
        label: toolLabel(name, args, rawArgs, repoRoot),
        detail: rawArgs === "" ? undefined : rawArgs,
        status: "running",
      };
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      // A follow-on outcome — the store is append-only, so we never upsert the
      // running event; we append the result as its own event.
      const output = typeof payload.output === "string" ? payload.output : "";
      const isError = outputIsError(output);
      return {
        kind: "tool",
        status: isError ? "error" : "ok",
        label: isError ? "→ error" : "→ ok",
        detail: output === "" ? undefined : output,
      };
    }
    default:
      return null;
  }
}

/** Every recognized event from one parsed rollout envelope, in record order. */
function lineToEvents(env: Envelope, repoRoot: string): RawStreamEvent[] {
  // Only `response_item` envelopes wrap the items we map; `session_meta`,
  // `turn_context`, `event_msg`, and anything else are skipped.
  if (env.type !== "response_item") return [];
  const payload = env.payload;
  if (!payload || typeof payload !== "object") return [];
  const event = payloadToEvent(payload, repoRoot);
  return event ? [event] : [];
}

/**
 * Read new bytes from `cursor.offset` to EOF, consume only COMPLETE lines, and
 * emit their events. A trailing partial line (no terminating newline) is left
 * unconsumed — the offset stays before it so the next poll completes it. The
 * advanced offset is the byte position just past the last complete line. Every
 * step is fail-soft.
 */
function parse(handle: TranscriptHandle, cursor: Cursor): { events: RawStreamEvent[]; cursor: Cursor } {
  const repoRoot = (cursor.repoRoot as string | undefined) ?? sessionCwd(handle.path) ?? "";
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
    let env: Envelope;
    try {
      env = JSON.parse(trimmed) as Envelope;
    } catch {
      continue; // skip a corrupt line, keep going
    }
    for (const event of lineToEvents(env, repoRoot)) events.push(event);
  }
  return { events, cursor: { ...cursor, offset: offset + consumedBytes, repoRoot } };
}

/** The Codex CLI rollout adapter (read-only, fail-soft). */
export const codexAdapter: TranscriptAdapter = {
  agent: AGENT,
  locate,
  parse,
};

// Test-only exports — the pure mappers are worth covering directly.
export const __test = { toolLabel, shellCommand, patchPath, relPath, reasoningText, messageText, outputIsError, lineToEvents };
