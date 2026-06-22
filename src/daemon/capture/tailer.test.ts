import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../shared/config.js";
import type { StreamEvent } from "../../shared/types.js";
import type { TranscriptAdapter, TranscriptHandle } from "./adapter.js";
import { claudeAdapter } from "./claude.js";
import { Tailer } from "./tailer.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "otacon-tailer-"));
  path = join(dir, "transcript.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const config = () => DEFAULT_CONFIG.stream;

/** Capture appends + publishes, mint seqs, and drive `tick()` manually. */
function harness(opts: {
  findAdapter: (repo: string) => { adapter: TranscriptAdapter; handle: TranscriptHandle } | null;
}) {
  const appended: StreamEvent[][] = [];
  const published: StreamEvent[][] = [];
  let seq = 0;
  const tailer = new Tailer({
    repoRoot: "/repo",
    nextSeq: () => ++seq,
    append: (events) => appended.push(events),
    publish: (events) => published.push(events),
    config,
    findAdapter: opts.findAdapter,
    // No real timer: the test drives `tick()`. `start()` still calls locate once.
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => {},
  });
  return { tailer, appended, published };
}

const lineFor = (text: string) =>
  JSON.stringify({ type: "assistant", cwd: "/repo", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";

describe("Tailer with the real Claude adapter over a temp file", () => {
  test("parse → normalize → store → publish on a tick", () => {
    writeFileSync(path, lineFor("hello world"));
    const handle: TranscriptHandle = { agent: "claude", path };
    const { tailer, appended, published } = harness({
      findAdapter: () => ({ adapter: claudeAdapter, handle }),
    });
    tailer.start();
    tailer.tick();

    expect(appended).toHaveLength(1);
    expect(appended[0]).toHaveLength(1);
    expect(appended[0]?.[0]).toMatchObject({ seq: 1, kind: "text", label: "hello world" });
    expect(appended[0]?.[0]?.at).toMatch(/^\d{4}-\d\d-\d\dT/); // daemon-stamped ISO
    // One coalesced frame for the batch.
    expect(published).toEqual(appended);
    tailer.stop();
  });

  test("a burst between ticks becomes ONE append + ONE frame", () => {
    const handle: TranscriptHandle = { agent: "claude", path };
    writeFileSync(path, "");
    const { tailer, appended, published } = harness({
      findAdapter: () => ({ adapter: claudeAdapter, handle }),
    });
    tailer.start();
    // Three lines land between ticks.
    appendFileSync(path, lineFor("a") + lineFor("b") + lineFor("c"));
    tailer.tick();

    expect(appended).toHaveLength(1); // one batch
    expect(published).toHaveLength(1); // one frame
    expect(appended[0]?.map((e) => e.label)).toEqual(["a", "b", "c"]);
    expect(appended[0]?.map((e) => e.seq)).toEqual([1, 2, 3]); // sequential seqs
    tailer.stop();
  });

  test("no new bytes → no append, no frame", () => {
    writeFileSync(path, lineFor("only line"));
    const handle: TranscriptHandle = { agent: "claude", path };
    const { tailer, appended, published } = harness({
      findAdapter: () => ({ adapter: claudeAdapter, handle }),
    });
    tailer.start();
    tailer.tick(); // consumes the one line
    tailer.tick(); // nothing new
    expect(appended).toHaveLength(1);
    expect(published).toHaveLength(1);
    tailer.stop();
  });

  test("re-locates when no transcript exists at start, then streams once it appears", () => {
    const handle: TranscriptHandle = { agent: "claude", path };
    let exists = false;
    const { tailer, appended } = harness({
      findAdapter: () => (exists ? { adapter: claudeAdapter, handle } : null),
    });
    tailer.start();
    tailer.tick(); // no adapter yet → floor
    expect(appended).toHaveLength(0);
    // The transcript appears a beat later.
    writeFileSync(path, lineFor("late start"));
    exists = true;
    tailer.tick(); // re-locates and streams
    expect(appended).toHaveLength(1);
    expect(appended[0]?.[0]?.label).toBe("late start");
    tailer.stop();
  });
});

describe("Tailer floor: no adapter for the repo's agent", () => {
  test("attaches no tailer activity at all (registry returns null)", () => {
    const { tailer, appended, published } = harness({ findAdapter: () => null });
    tailer.start();
    tailer.tick();
    tailer.tick();
    expect(appended).toEqual([]);
    expect(published).toEqual([]);
    tailer.stop();
  });
});

describe("Tailer is fail-soft", () => {
  test("a throwing append on one tick does not kill the loop", () => {
    writeFileSync(path, lineFor("one"));
    const handle: TranscriptHandle = { agent: "claude", path };
    let seq = 0;
    let throwOnce = true;
    const published: StreamEvent[][] = [];
    const tailer = new Tailer({
      repoRoot: "/repo",
      nextSeq: () => ++seq,
      append: () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("disk full");
        }
      },
      publish: (events) => published.push(events),
      config,
      findAdapter: () => ({ adapter: claudeAdapter, handle }),
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => {},
    });
    tailer.start();
    expect(() => tailer.tick()).not.toThrow(); // the first tick throws inside, swallowed
    appendFileSync(path, lineFor("two"));
    tailer.tick(); // recovers
    expect(published.length).toBeGreaterThan(0);
    tailer.stop();
  });

  test("start/stop are idempotent", () => {
    const { tailer } = harness({ findAdapter: () => null });
    tailer.start();
    tailer.start();
    tailer.stop();
    tailer.stop();
    // no throw
    expect(true).toBe(true);
  });
});
