// The OpenCode transcript adapter. Unlike Claude/Codex — each one JSONL file —
// OpenCode persists its sessions in a local SQLite database
// (`$XDG_DATA_HOME/opencode/opencode.db`, default `~/.local/share/opencode/`),
// with one row per session/message/part. We read that DB *read-only* with Node's
// built-in `node:sqlite` (zero new npm deps), which keeps the same file-based,
// no-extra-process model as the other adapters — no `opencode serve` to spawn.
//
// Schema we rely on (confirmed against a real install, storage migration 2):
//   - `session(id, directory, time_created, time_updated, …)` — `directory` is
//     the session's recorded cwd; that is the authoritative repo key.
//   - `message(id, session_id, time_created, data)` — `data` JSON has a `role`.
//   - `part(id, message_id, session_id, time_created, time_updated, data)` —
//     `data` JSON's `type` is one of `text` / `reasoning` / `tool` / … We map
//     `text` → text, `reasoning` → thinking, and `tool` → a `running` event plus,
//     once its `state.status` settles, a SEPARATE `ok`/`error` outcome event.
//
// Because the source is a DB (rows, not a byte stream), the `Cursor`'s `offset`
// is unused — incrementality lives in the opaque carry: a high-water
// `time_created` watermark plus the set of part ids already emitted *at exactly*
// that watermark (so a same-millisecond insert is neither re-emitted nor
// dropped). The daemon round-trips the carry untouched, exactly as it does the
// byte offset for the JSONL adapters.
//
// Everything is fail-soft: a missing `node:sqlite` runtime (Node < 22), a locked
// or vanished DB, a torn `data` JSON, or any query error is swallowed — at worst
// the session runs on the `otacon progress` floor.

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Cursor, RawStreamEvent, TranscriptAdapter, TranscriptHandle } from "./adapter.js";

const AGENT = "opencode";

// The daemon ships as an ESM bundle (`"type": "module"`), where the bare global
// `require` is undefined — so we mint a CommonJS-style `require` bound to this
// module via `createRequire`. That is the only way to load a built-in
// SYNCHRONOUSLY from ESM (`locate`/`parse` are sync per the adapter contract, so
// `await import()` is not an option). On Node < 22 or under bun, `node:sqlite`
// is absent and this `require` throws — caught below, degrading to the floor.
const nodeRequire = createRequire(import.meta.url);

/**
 * A minimal read-only SQLite handle — just enough of `node:sqlite`'s shape that
 * the adapter compiles without the (Node-version-gated, experimental) types, and
 * stays decoupled from the concrete driver for testing.
 */
interface RoDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

/** Opens `path` read-only via `node:sqlite`, or null when unavailable/unreadable. */
function defaultOpen(path: string): RoDatabase | null {
  let mod: { DatabaseSync: new (p: string, opts: { readonly: boolean }) => RoDatabase };
  try {
    // `node:sqlite` is built in on Node >= 22. require() so a missing module on
    // an older runtime throws here and is swallowed (floor), not at import time.
    mod = nodeRequire("node:sqlite") as typeof mod;
  } catch {
    return null;
  }
  try {
    return new mod.DatabaseSync(path, { readonly: true });
  } catch {
    return null; // DB missing, locked exclusively, or corrupt — degrade to floor
  }
}

/** Test seam: the daemon uses the real `node:sqlite`; a test injects a fake. */
let openDb: (path: string) => RoDatabase | null = defaultOpen;
/** @internal — swap the SQLite opener (tests only). */
export function __setOpenDb(fn: (path: string) => RoDatabase | null): void {
  openDb = fn;
}

/** `$XDG_DATA_HOME/opencode` (if set) else `~/.local/share/opencode`. */
function dataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (typeof xdg === "string" && xdg !== "") return join(xdg, "opencode");
  // Prefer $HOME (the standard override; what a test or custom-home user
  // expects) and fall back to os.homedir() — Bun's homedir() ignores $HOME.
  const home = process.env.HOME && process.env.HOME !== "" ? process.env.HOME : homedir();
  return join(home, ".local", "share", "opencode");
}

/** The OpenCode SQLite DB path: `<dataRoot>/opencode.db`. */
function dbPath(): string {
  return join(dataRoot(), "opencode.db");
}

/** Run a query fail-soft, always closing the handle; [] on any error. */
function query(path: string, sql: string, params: unknown[]): unknown[] {
  const db = openDb(path);
  if (!db) return [];
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return []; // bad SQL/schema drift/locked read — degrade to floor
  } finally {
    try {
      db.close();
    } catch {
      // best-effort close — never throw out of a fail-soft path
    }
  }
}

/**
 * The freshest session whose recorded `directory` equals `repoRoot`. We let
 * SQLite do the filter + newest-first ordering and take the first row. The
 * returned handle's `path` is the DB file; the resolved session id rides on the
 * carry (stashed by `parse`, keyed off this same query). Null when the DB is
 * missing/unreadable or no session matches. Never throws.
 */
function locate(repoRoot: string): TranscriptHandle | null {
  const path = dbPath();
  const rows = query(
    path,
    "SELECT id FROM session WHERE directory = ? ORDER BY time_updated DESC, time_created DESC LIMIT 1",
    [repoRoot],
  );
  const id = rows[0] && typeof rows[0] === "object" ? (rows[0] as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || id === "") return null;
  // Encode the session id into the handle path (`<db>#<sessionId>`) so `parse`
  // knows which session to scan without re-running the directory match — the
  // TranscriptHandle has no field for it, and the cwd→session mapping is fixed
  // for a located handle's lifetime.
  return { agent: AGENT, path: `${path}#${id}` };
}

/** Split a `<db>#<sessionId>` handle path back into its parts. */
function splitHandle(handlePath: string): { dbFile: string; sessionId: string } {
  const hash = handlePath.lastIndexOf("#");
  if (hash === -1) return { dbFile: handlePath, sessionId: "" };
  return { dbFile: handlePath.slice(0, hash), sessionId: handlePath.slice(hash + 1) };
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

/** A part's parsed `data` JSON; only the fields we map are typed. */
interface PartState {
  status?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: unknown;
  title?: unknown;
}
interface PartData {
  type?: string;
  text?: unknown;
  tool?: unknown;
  state?: PartState;
}

/**
 * Concise label for a tool part, e.g. "Bash: bun test" / "Read src/x.ts". Tool
 * names are lowercase in OpenCode; we render the same verbs as the Claude
 * adapter. Falls back to the tool's title (OpenCode computes a useful one) or
 * the bare tool name.
 */
function toolLabel(tool: string, input: Record<string, unknown>, title: string, repoRoot: string): string {
  const file = (k: string) => relPath(String(input[k] ?? ""), repoRoot);
  switch (tool) {
    case "bash": {
      const cmd = String(input.command ?? "");
      return cmd === "" ? "Bash" : `Bash: ${clamp(cmd)}`;
    }
    case "read":
      return `Read ${file("filePath")}`;
    case "edit":
      return `Edit ${file("filePath")}`;
    case "write":
      return `Write ${file("filePath")}`;
    case "grep":
      return `Grep ${String(input.pattern ?? "")}`;
    case "glob":
      return `Glob ${String(input.pattern ?? "")}`;
    case "webfetch":
      return `Fetch ${String(input.url ?? "")}`;
    case "websearch":
      return `Search: ${String(input.query ?? "")}`;
    case "task":
      return `Task: ${String(input.description ?? input.prompt ?? "")}`;
    default:
      // A meaningful title (OpenCode often sets one, e.g. a glob pattern) beats
      // the bare lowercase tool name; otherwise show the name.
      return title !== "" ? `${tool}: ${clamp(title)}` : tool;
  }
}

/** Coerce a tool `state.output`/`error` to a one-line-safe detail string. */
function detailText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined || v === null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/**
 * Map one part's parsed `data` to the events it produces — possibly TWO for a
 * settled tool (the `running` event and its `ok`/`error` outcome, appended
 * separately so the store never upserts). Unrecognized types yield nothing.
 */
function partToEvents(data: PartData, repoRoot: string): RawStreamEvent[] {
  switch (data.type) {
    case "text": {
      const text = typeof data.text === "string" ? data.text : "";
      if (text.trim() === "") return [];
      return [{ kind: "text", label: clamp(text) || "text", detail: text }];
    }
    case "reasoning": {
      const text = typeof data.text === "string" ? data.text : "";
      if (text.trim() === "") return [];
      return [{ kind: "thinking", label: "thinking…", detail: text }];
    }
    case "tool": {
      const tool = typeof data.tool === "string" ? data.tool : "tool";
      const state = data.state && typeof data.state === "object" ? data.state : {};
      const input = state.input && typeof state.input === "object" ? state.input : {};
      const title = typeof state.title === "string" ? state.title : "";
      const rawInput = (() => {
        try {
          return JSON.stringify(input);
        } catch {
          return "";
        }
      })();
      const events: RawStreamEvent[] = [
        {
          kind: "tool",
          tool,
          label: toolLabel(tool, input, title, repoRoot),
          detail: rawInput === "" || rawInput === "{}" ? undefined : rawInput,
          status: "running",
        },
      ];
      // A settled tool carries its outcome on the same part (OpenCode mutates the
      // part in place as the tool runs). We still emit the outcome as its OWN
      // event to keep the append-only "running then ok/error" shape; a part that
      // is still `pending`/`running` only yields the running event for now and
      // its outcome arrives when the part's `time_updated` bumps it back to us.
      const status = state.status;
      if (status === "completed") {
        const detail = detailText(state.output);
        events.push({ kind: "tool", status: "ok", label: "→ ok", detail: detail === "" ? undefined : detail });
      } else if (status === "error") {
        const detail = detailText(state.error) || detailText(state.output);
        events.push({ kind: "tool", status: "error", label: "→ error", detail: detail === "" ? undefined : detail });
      }
      return events;
    }
    default:
      return []; // step-start/step-finish/patch/file/compaction/… are not activity
  }
}

/** The carry the watermark cursor rides on (everything but `offset`). */
interface OpenCodeCarry {
  /** Resolved repo root (recorded session directory) — stashed once. */
  repoRoot?: string;
  /** High-water `time_created` (ms) already fully emitted. */
  watermark?: number;
  /** Part ids emitted at EXACTLY `watermark` (tie set; bounded to the frontier). */
  emittedAtWatermark?: string[];
}

/** A `part` row, as the columns the query selects. */
interface PartRow {
  id?: unknown;
  time_created?: unknown;
  time_updated?: unknown;
  data?: unknown;
}

/**
 * Scan the located session's parts newer than the cursor watermark, in
 * chronological order, and emit their events. Incrementality lives in the carry:
 * we ask for `time_created >= watermark` (so a part inserted in the SAME
 * millisecond as the last frontier is not missed), then skip any id already
 * emitted at exactly that watermark. After emitting, the watermark advances to
 * the newest `time_created` we saw and the tie set is reset to just the ids at
 * that new frontier — bounded, and enough to dedupe the next same-ms insert.
 * Fail-soft throughout: a missing DB, a torn `data` JSON, or a query error
 * yields no events and leaves the cursor put.
 */
function parse(handle: TranscriptHandle, cursor: Cursor): { events: RawStreamEvent[]; cursor: Cursor } {
  const { dbFile, sessionId } = splitHandle(handle.path);
  if (sessionId === "") return { events: [], cursor };

  const carry = cursor as OpenCodeCarry & Cursor;
  const watermark = typeof carry.watermark === "number" && carry.watermark >= 0 ? carry.watermark : 0;
  const emitted = Array.isArray(carry.emittedAtWatermark) ? new Set(carry.emittedAtWatermark) : new Set<string>();

  // Resolve repoRoot once (from the session row) and stash it on the carry.
  let repoRoot = typeof carry.repoRoot === "string" ? carry.repoRoot : undefined;
  if (repoRoot === undefined) {
    const sess = query(dbFile, "SELECT directory FROM session WHERE id = ? LIMIT 1", [sessionId]);
    const dir = sess[0] && typeof sess[0] === "object" ? (sess[0] as { directory?: unknown }).directory : undefined;
    repoRoot = typeof dir === "string" ? dir : "";
  }

  const rows = query(
    dbFile,
    "SELECT id, time_created, data FROM part WHERE session_id = ? AND time_created >= ? ORDER BY time_created ASC, id ASC",
    [sessionId, watermark],
  ) as PartRow[];

  const events: RawStreamEvent[] = [];
  let maxTime = watermark;
  const idsAtMax: string[] = emitted.size > 0 ? [...emitted] : []; // carry forward the current frontier's tie set
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : undefined;
    const tCreated = typeof row.time_created === "number" ? row.time_created : 0;
    if (id === undefined) continue;
    if (emitted.has(id)) continue; // already emitted at the prior watermark — skip
    let data: PartData;
    try {
      const raw = typeof row.data === "string" ? row.data : "";
      const parsed = raw === "" ? {} : JSON.parse(raw);
      data = parsed && typeof parsed === "object" ? (parsed as PartData) : {};
    } catch {
      continue; // torn `data` JSON — skip this part, keep going
    }
    for (const event of partToEvents(data, repoRoot)) events.push(event);
    // Advance the frontier. A part AT the current max joins its tie set; a newer
    // one resets the tie set to just itself.
    if (tCreated > maxTime) {
      maxTime = tCreated;
      idsAtMax.length = 0;
      idsAtMax.push(id);
    } else if (tCreated === maxTime) {
      idsAtMax.push(id);
    }
  }

  const nextCursor: Cursor = {
    ...cursor,
    offset: 0, // unused for a DB source; kept for the opaque-cursor contract
    repoRoot,
    watermark: maxTime,
    emittedAtWatermark: idsAtMax,
  };
  return { events, cursor: nextCursor };
}

/** The OpenCode SQLite adapter (read-only, fail-soft). */
export const opencodeAdapter: TranscriptAdapter = {
  agent: AGENT,
  locate,
  parse,
};

// Test-only exports — the pure mappers + path helpers are worth covering directly.
export const __test = { toolLabel, relPath, detailText, partToEvents, splitHandle, dbPath, dataRoot };
