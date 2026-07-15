import { describe, expect, test } from "bun:test";
import type { RegistrySession } from "../shared/types.js";
import { fetchPrState, startPrPolling } from "./pr-status.js";
import type { PrState } from "./pr-status.js";

const URL = "https://github.com/acme/widgets/pull/42";

/** A fake `run` that resolves the given gh stdout (no real process spawn). */
function ok(stdout: string): { run: (args: string[]) => Promise<string> } {
  return { run: () => Promise.resolve(stdout) };
}

/** A fake `run` that rejects, simulating gh missing / non-zero exit / network error. */
function fail(message: string): { run: (args: string[]) => Promise<string> } {
  return { run: () => Promise.reject(new Error(message)) };
}

describe("fetchPrState", () => {
  test('maps {"state":"OPEN"} → "open"', async () => {
    expect(await fetchPrState(URL, ok('{"state":"OPEN"}'))).toBe("open");
  });

  test('maps {"state":"MERGED"} → "merged"', async () => {
    expect(await fetchPrState(URL, ok('{"state":"MERGED"}'))).toBe("merged");
  });

  test('maps {"state":"CLOSED"} → "closed"', async () => {
    expect(await fetchPrState(URL, ok('{"state":"CLOSED"}'))).toBe("closed");
  });

  test("passes the expected gh argv to run", async () => {
    let seen: string[] | undefined;
    await fetchPrState(URL, {
      run: (args) => {
        seen = args;
        return Promise.resolve('{"state":"OPEN"}');
      },
    });
    expect(seen).toEqual(["pr", "view", URL, "--json", "state"]);
  });

  test("returns undefined when run rejects (gh missing / non-zero exit)", async () => {
    expect(await fetchPrState(URL, fail("spawn gh ENOENT"))).toBeUndefined();
  });

  test("returns undefined on malformed JSON", async () => {
    expect(await fetchPrState(URL, ok("not json at all"))).toBeUndefined();
  });

  test("returns undefined on empty stdout", async () => {
    expect(await fetchPrState(URL, ok(""))).toBeUndefined();
  });

  test("returns undefined on an unexpected/unknown state value", async () => {
    expect(await fetchPrState(URL, ok('{"state":"DRAFT"}'))).toBeUndefined();
  });

  test("returns undefined when the state field is absent", async () => {
    expect(await fetchPrState(URL, ok('{"number":42}'))).toBeUndefined();
  });
});

/** Minimal RegistrySession stub: only the fields the poller reads matter. */
function session(over: Partial<Extract<RegistrySession, { kind: "plan" }>>): RegistrySession {
  return {
    kind: "plan",
    id: "otc_x",
    title: "t",
    repo: "/r",
    branch: "",
    quick: false,
    socratic: false,
    status: "implemented",
    createdAt: "now",
    updatedAt: "now",
    ...over,
  };
}

/** In-memory store + publish recorder, plus a fetch that maps prUrl → state. */
function harness(
  sessions: RegistrySession[],
  fetchMap: Record<string, PrState | undefined>,
) {
  const fetched: string[] = [];
  const updates: Array<{ id: string; patch: { prState: PrState } }> = [];
  const published: string[] = [];
  const deps = {
    listSessions: () => sessions,
    updateSession: (id: string, patch: { prState: PrState }) => {
      updates.push({ id, patch });
    },
    publish: (id: string) => {
      published.push(id);
    },
    fetchPrState: (url: string) => {
      fetched.push(url);
      return Promise.resolve(fetchMap[url]);
    },
    // Don't arm a real timer in the poll-behavior tests.
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => {},
  };
  return { deps, fetched, updates, published };
}

describe("startPrPolling pollNow", () => {
  test('open → merged updates prState and publishes', async () => {
    const url = "https://github.com/a/b/pull/1";
    const { deps, updates, published } = harness(
      [session({ id: "s1", prUrl: url, prState: "open" })],
      { [url]: "merged" },
    );
    await startPrPolling(deps).pollNow();
    expect(updates).toEqual([{ id: "s1", patch: { prState: "merged" } }]);
    expect(published).toEqual(["s1"]);
  });

  test("a settled (merged) PR is never re-queried", async () => {
    const url = "https://github.com/a/b/pull/2";
    const { deps, fetched, updates, published } = harness(
      [session({ id: "s1", prUrl: url, prState: "merged" })],
      { [url]: "closed" },
    );
    await startPrPolling(deps).pollNow();
    expect(fetched).toEqual([]);
    expect(updates).toEqual([]);
    expect(published).toEqual([]);
  });

  test("a settled (closed) PR is never re-queried", async () => {
    const url = "https://github.com/a/b/pull/3";
    const { deps, fetched } = harness(
      [session({ id: "s1", prUrl: url, prState: "closed" })],
      { [url]: "open" },
    );
    await startPrPolling(deps).pollNow();
    expect(fetched).toEqual([]);
  });

  test("undefined prState that probes to the same value (open) does not publish", async () => {
    const url = "https://github.com/a/b/pull/4";
    const { deps, fetched, updates, published } = harness(
      [session({ id: "s1", prUrl: url, prState: undefined })],
      { [url]: "open" },
    );
    await startPrPolling(deps).pollNow();
    expect(fetched).toEqual([url]); // eligible: it WAS probed
    expect(updates).toEqual([]); // but the value didn't differ
    expect(published).toEqual([]);
  });

  test("undefined prState that probes to closed updates and publishes", async () => {
    const url = "https://github.com/a/b/pull/5";
    const { deps, updates, published } = harness(
      [session({ id: "s1", prUrl: url, prState: undefined })],
      { [url]: "closed" },
    );
    await startPrPolling(deps).pollNow();
    expect(updates).toEqual([{ id: "s1", patch: { prState: "closed" } }]);
    expect(published).toEqual(["s1"]);
  });

  test("a session with no prUrl is never fetched", async () => {
    const { deps, fetched, updates, published } = harness(
      [session({ id: "s1", prUrl: undefined, prState: undefined })],
      {},
    );
    await startPrPolling(deps).pollNow();
    expect(fetched).toEqual([]);
    expect(updates).toEqual([]);
    expect(published).toEqual([]);
  });

  test("an indeterminate probe (undefined) leaves the session unchanged", async () => {
    const url = "https://github.com/a/b/pull/6";
    const { deps, fetched, updates, published } = harness(
      [session({ id: "s1", prUrl: url, prState: "open" })],
      { [url]: undefined },
    );
    await startPrPolling(deps).pollNow();
    expect(fetched).toEqual([url]);
    expect(updates).toEqual([]);
    expect(published).toEqual([]);
  });

  test("polls multiple eligible sessions in one sweep", async () => {
    const u1 = "https://github.com/a/b/pull/7";
    const u2 = "https://github.com/a/b/pull/8";
    const { deps, updates, published } = harness(
      [
        session({ id: "s1", prUrl: u1, prState: "open" }),
        session({ id: "s2", prUrl: u2, prState: undefined }),
      ],
      { [u1]: "merged", [u2]: "closed" },
    );
    await startPrPolling(deps).pollNow();
    expect(updates).toContainEqual({ id: "s1", patch: { prState: "merged" } });
    expect(updates).toContainEqual({ id: "s2", patch: { prState: "closed" } });
    expect(published.sort()).toEqual(["s1", "s2"]);
  });
});

describe("startPrPolling timer seam", () => {
  test("schedules pollNow at the given interval; firing it polls; stop clears it", async () => {
    const url = "https://github.com/a/b/pull/9";
    let cb: (() => void) | undefined;
    let scheduledMs: number | undefined;
    const fetched: string[] = [];
    const handle = 42 as unknown as ReturnType<typeof setInterval>;
    let cleared: ReturnType<typeof setInterval> | undefined;

    const { stop } = startPrPolling({
      listSessions: () => [session({ id: "s1", prUrl: url, prState: "open" })],
      updateSession: () => {},
      publish: () => {},
      fetchPrState: (u) => {
        fetched.push(u);
        return Promise.resolve<PrState>("merged");
      },
      intervalMs: 12_345,
      setInterval: (fn, ms) => {
        cb = fn;
        scheduledMs = ms;
        return handle;
      },
      clearInterval: (h) => {
        cleared = h;
      },
    });

    expect(scheduledMs).toBe(12_345);
    expect(fetched).toEqual([]); // not auto-run on start

    cb?.(); // fire the fake timer
    await Promise.resolve(); // let the async pollNow settle
    await Promise.resolve();
    expect(fetched).toEqual([url]);

    stop();
    expect(cleared).toBe(handle);
  });
});
