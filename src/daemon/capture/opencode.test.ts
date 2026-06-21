import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Cursor, TranscriptHandle } from "./adapter.js";
import { INITIAL_CURSOR } from "./adapter.js";
import { __setOpenDb, __test, opencodeAdapter } from "./opencode.js";

const FIXTURE = fileURLToPath(new URL("../../../test/fixtures/opencode-storage.json", import.meta.url));

interface SessionRow {
  id: string;
  directory: string;
  time_created: number;
  time_updated: number;
}
interface PartRow {
  id: string;
  session_id: string;
  time_created: number;
  data: Record<string, unknown>;
}
interface Store {
  session: SessionRow[];
  part: PartRow[];
}

function loadFixture(): Store {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as Store;
  return { session: raw.session, part: raw.part };
}

/**
 * A fake read-only `node:sqlite` DB serving an in-memory store. It recognizes
 * exactly the queries the adapter issues, so the test exercises the real SQL
 * shape without a Node-only `node:sqlite` (bun's test runner lacks it). `data`
 * rows are returned as JSON strings, matching the real DB's TEXT column.
 */
function fakeDb(store: Store) {
  return {
    prepare(sql: string) {
      return {
        all(...params: unknown[]): unknown[] {
          if (sql.includes("FROM session WHERE directory")) {
            const [dir] = params as [string];
            return store.session
              .filter((s) => s.directory === dir)
              .sort((a, b) => b.time_updated - a.time_updated || b.time_created - a.time_created)
              .slice(0, 1)
              .map((s) => ({ id: s.id }));
          }
          if (sql.includes("FROM session WHERE id")) {
            const [id] = params as [string];
            return store.session.filter((s) => s.id === id).slice(0, 1).map((s) => ({ directory: s.directory }));
          }
          if (sql.includes("FROM part WHERE session_id")) {
            const [sessionId, watermark] = params as [string, number];
            return store.part
              .filter((p) => p.session_id === sessionId && p.time_created >= watermark)
              .sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              .map((p) => ({ id: p.id, time_created: p.time_created, data: JSON.stringify(p.data) }));
          }
          return [];
        },
      };
    },
    close() {
      /* no-op */
    },
  };
}

/** Install a fake DB built from `store`; record what path the adapter opened. */
function install(store: Store): { opened: string[] } {
  const opened: string[] = [];
  __setOpenDb((path) => {
    opened.push(path);
    return fakeDb(store);
  });
  return { opened };
}

afterEach(() => {
  // Restore the real opener (the import-time default).
  __setOpenDb((path) => {
    try {
      const mod = require("node:sqlite") as { DatabaseSync: new (p: string, o: object) => never };
      return new mod.DatabaseSync(path, { readonly: true }) as never;
    } catch {
      return null;
    }
  });
});

const handle = (p: string): TranscriptHandle => ({ agent: "opencode", path: p });

describe("locate", () => {
  test("finds the freshest session whose directory matches the repo root", () => {
    install(loadFixture());
    const located = opencodeAdapter.locate("/Users/test/myrepo");
    expect(located?.agent).toBe("opencode");
    // Handle path is `<db>#<sessionId>`; the matched session id is encoded.
    expect(located?.path).toContain("#ses_synthmatch00000000000001");
    expect(located?.path).toContain("opencode.db");
  });

  test("rejects a foreign cwd (a session for a different repo) → null", () => {
    install(loadFixture());
    expect(opencodeAdapter.locate("/Users/test/not-a-repo-here")).toBeNull();
  });

  test("a session for /otherrepo is not returned for /myrepo", () => {
    install(loadFixture());
    const located = opencodeAdapter.locate("/Users/test/otherrepo");
    expect(located?.path).toContain("#ses_synthother00000000000002");
  });

  test("fail-soft when the DB can't be opened (null opener) → null", () => {
    __setOpenDb(() => null);
    expect(opencodeAdapter.locate("/Users/test/myrepo")).toBeNull();
  });
});

describe("parse: the synthetic session from a fresh cursor", () => {
  test("a tool part and an assistant text part yield a tool event and a text event for R", () => {
    install(loadFixture());
    const located = opencodeAdapter.locate("/Users/test/myrepo");
    expect(located).not.toBeNull();
    const { events } = opencodeAdapter.parse(located as TranscriptHandle, { ...INITIAL_CURSOR });

    // Chronological order: reasoning → tool(running) → tool outcome → text.
    expect(events.map((e) => e.label)).toEqual([
      "thinking…",
      "Bash: bun test src/fetch.test.ts",
      "→ ok",
      "The baseline tests pass. I'll add the retry wrapper next.",
    ]);

    // The behavioral assertion: a tool part yields a tool event and the
    // assistant text part yields a text event.
    const tool = events.find((e) => e.kind === "tool" && e.status === "running");
    expect(tool).toMatchObject({ kind: "tool", tool: "bash", status: "running" });
    expect(tool?.label).toBe("Bash: bun test src/fetch.test.ts");
    expect(tool?.detail).toContain("bun test");
    const text = events.find((e) => e.kind === "text");
    expect(text?.detail).toContain("retry wrapper");

    // The outcome is a SEPARATE appended event (append-only), not a mutation.
    const outcome = events.find((e) => e.label === "→ ok");
    expect(outcome).toMatchObject({ kind: "tool", status: "ok" });
    expect(outcome?.detail).toContain("1 pass");
  });

  test("the cursor watermark advances and a second parse re-emits nothing", () => {
    install(loadFixture());
    const located = opencodeAdapter.locate("/Users/test/myrepo") as TranscriptHandle;
    const first = opencodeAdapter.parse(located, { ...INITIAL_CURSOR });
    expect(first.events.length).toBeGreaterThan(0);
    // Watermark is the newest part's time_created; the tie set holds that part.
    expect(first.cursor.watermark).toBe(1782045411000);
    expect(first.cursor.emittedAtWatermark).toEqual(["prt_synth_text_00000000003"]);

    const second = opencodeAdapter.parse(located, first.cursor);
    expect(second.events).toEqual([]);
    expect(second.cursor.watermark).toBe(first.cursor.watermark);
  });

  test("a part inserted in the SAME ms as the frontier is emitted once, never dropped or doubled", () => {
    const store = loadFixture();
    install(store);
    const located = opencodeAdapter.locate("/Users/test/myrepo") as TranscriptHandle;
    const first = opencodeAdapter.parse(located, { ...INITIAL_CURSOR });
    // A new text part arrives at EXACTLY the current watermark (same ms tie).
    store.part.push({
      id: "prt_synth_text_zzz_sametime",
      session_id: "ses_synthmatch00000000000001",
      time_created: first.cursor.watermark as number,
      data: { type: "text", text: "A same-millisecond follow-up." },
    });
    const second = opencodeAdapter.parse(located, first.cursor);
    expect(second.events.map((e) => e.label)).toEqual(["A same-millisecond follow-up."]);
    // It is now in the tie set, so a third parse does not replay it.
    const third = opencodeAdapter.parse(located, second.cursor);
    expect(third.events).toEqual([]);
  });

  test("a pending tool part emits only the running event (outcome arrives later)", () => {
    const store = loadFixture();
    store.part = [
      {
        id: "prt_pending_0001",
        session_id: "ses_synthmatch00000000000001",
        time_created: 1782045412000,
        data: { type: "tool", tool: "read", state: { status: "pending", input: { filePath: "/Users/test/myrepo/src/x.ts" } } },
      },
    ];
    install(store);
    const located = opencodeAdapter.locate("/Users/test/myrepo") as TranscriptHandle;
    const { events } = opencodeAdapter.parse(located, { ...INITIAL_CURSOR });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "tool", status: "running", label: "Read src/x.ts" });
  });

  test("an error tool part emits a → error outcome carrying the error detail", () => {
    const store = loadFixture();
    store.part = [
      {
        id: "prt_err_0001",
        session_id: "ses_synthmatch00000000000001",
        time_created: 1782045412000,
        data: { type: "tool", tool: "bash", state: { status: "error", input: { command: "false" }, error: "exited with code 1" } },
      },
    ];
    install(store);
    const located = opencodeAdapter.locate("/Users/test/myrepo") as TranscriptHandle;
    const { events } = opencodeAdapter.parse(located, { ...INITIAL_CURSOR });
    expect(events.map((e) => e.label)).toEqual(["Bash: false", "→ error"]);
    expect(events[1]).toMatchObject({ kind: "tool", status: "error" });
    expect(events[1]?.detail).toContain("code 1");
  });
});

describe("parse: fail-soft", () => {
  test("a handle with no session id yields nothing and leaves the cursor put", () => {
    install(loadFixture());
    const c: Cursor = { offset: 0, watermark: 123 };
    const { events, cursor } = opencodeAdapter.parse(handle("/some/opencode.db"), c);
    expect(events).toEqual([]);
    expect(cursor).toBe(c);
  });

  test("a torn `data` JSON on one part is skipped, not thrown", () => {
    const store = loadFixture();
    install(store);
    const located = opencodeAdapter.locate("/Users/test/myrepo") as TranscriptHandle;
    // Inject a fake DB whose part query returns a row with non-JSON `data`.
    __setOpenDb(() => ({
      prepare(sql: string) {
        return {
          all(...params: unknown[]): unknown[] {
            if (sql.includes("FROM session WHERE id")) return [{ directory: "/Users/test/myrepo" }];
            if (sql.includes("FROM part")) {
              return [
                { id: "p1", time_created: 1, data: "{ not json" },
                { id: "p2", time_created: 2, data: JSON.stringify({ type: "text", text: "survived" }) },
              ];
            }
            return [];
          },
        };
      },
      close() {},
    }));
    const { events } = opencodeAdapter.parse(located, { ...INITIAL_CURSOR });
    expect(events.map((e) => e.label)).toEqual(["survived"]);
  });

  test("a throwing query is swallowed (fail-soft) → no events", () => {
    __setOpenDb(() => ({
      prepare() {
        return {
          all() {
            throw new Error("db is locked");
          },
        };
      },
      close() {},
    }));
    // locate swallows the throw → null; a manual handle then parses to nothing.
    expect(opencodeAdapter.locate("/Users/test/myrepo")).toBeNull();
    const { events } = opencodeAdapter.parse(handle("/db#ses_x"), { ...INITIAL_CURSOR });
    expect(events).toEqual([]);
  });
});

describe("pure mappers", () => {
  test("toolLabel: lowercase tools render Claude-style verbs", () => {
    const repo = "/repo";
    expect(__test.toolLabel("bash", { command: "git status" }, "", repo)).toBe("Bash: git status");
    expect(__test.toolLabel("read", { filePath: "/repo/src/x.ts" }, "", repo)).toBe("Read src/x.ts");
    expect(__test.toolLabel("edit", { filePath: "/repo/a/b.ts" }, "", repo)).toBe("Edit a/b.ts");
    expect(__test.toolLabel("write", { filePath: "/repo/new.ts" }, "", repo)).toBe("Write new.ts");
    expect(__test.toolLabel("grep", { pattern: "TODO" }, "", repo)).toBe("Grep TODO");
    expect(__test.toolLabel("glob", { pattern: "**/*.ts" }, "**/*.ts", repo)).toBe("Glob **/*.ts");
    expect(__test.toolLabel("websearch", { query: "node sqlite readonly" }, "", repo)).toBe("Search: node sqlite readonly");
  });

  test("toolLabel: an unknown tool falls back to its title, then its bare name", () => {
    expect(__test.toolLabel("todowrite", {}, "Update the plan", "/repo")).toBe("todowrite: Update the plan");
    expect(__test.toolLabel("mystery", {}, "", "/repo")).toBe("mystery");
  });

  test("toolLabel: a long bash command is clamped with an ellipsis", () => {
    const long = "echo " + "x".repeat(200);
    const label = __test.toolLabel("bash", { command: long }, "", "/repo");
    expect(label.length).toBeLessThan(90);
    expect(label.endsWith("…")).toBe(true);
  });

  test("partToEvents: text/reasoning map to text/thinking; empty bodies are skipped", () => {
    expect(__test.partToEvents({ type: "text", text: "hi" }, "/repo")).toEqual([
      { kind: "text", label: "hi", detail: "hi" },
    ]);
    expect(__test.partToEvents({ type: "reasoning", text: "pondering" }, "/repo")).toEqual([
      { kind: "thinking", label: "thinking…", detail: "pondering" },
    ]);
    expect(__test.partToEvents({ type: "text", text: "   " }, "/repo")).toEqual([]);
    expect(__test.partToEvents({ type: "reasoning", text: "" }, "/repo")).toEqual([]);
  });

  test("partToEvents: unrecognized part types yield nothing", () => {
    expect(__test.partToEvents({ type: "step-start" }, "/repo")).toEqual([]);
    expect(__test.partToEvents({ type: "patch" }, "/repo")).toEqual([]);
    expect(__test.partToEvents({ type: "file" }, "/repo")).toEqual([]);
    expect(__test.partToEvents({}, "/repo")).toEqual([]);
  });

  test("partToEvents: a completed tool yields running + ok as two events", () => {
    const events = __test.partToEvents(
      { type: "tool", tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "a\nb" } },
      "/repo",
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "tool", tool: "bash", status: "running", label: "Bash: ls" });
    expect(events[1]).toMatchObject({ kind: "tool", status: "ok", label: "→ ok" });
    expect(events[1]?.detail).toBe("a\nb");
  });

  test("detailText: strings pass through; objects JSON-stringify; nullish → empty", () => {
    expect(__test.detailText("plain")).toBe("plain");
    expect(__test.detailText({ a: 1 })).toBe('{"a":1}');
    expect(__test.detailText(undefined)).toBe("");
    expect(__test.detailText(null)).toBe("");
  });

  test("splitHandle: splits `<db>#<sessionId>`; a bare path has no session", () => {
    expect(__test.splitHandle("/x/opencode.db#ses_1")).toEqual({ dbFile: "/x/opencode.db", sessionId: "ses_1" });
    expect(__test.splitHandle("/x/opencode.db")).toEqual({ dbFile: "/x/opencode.db", sessionId: "" });
  });

  test("dataRoot honors XDG_DATA_HOME, else ~/.local/share/opencode", () => {
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = "/tmp/xdg";
    expect(__test.dataRoot()).toBe("/tmp/xdg/opencode");
    expect(__test.dbPath()).toBe("/tmp/xdg/opencode/opencode.db");
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  });
});
