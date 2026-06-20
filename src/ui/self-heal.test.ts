// Pins the open-tab self-heal contract (install/update): reload exactly once on a
// daemon version change, never on a match/empty version, and never twice for the
// same target. No DOM library needed — we stub the three browser globals the
// module touches (window, sessionStorage, location.reload) directly, so the test
// stays hermetic and fast under bun.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { maybeSelfHeal } from "./self-heal.js";

const g = globalThis as Record<string, unknown>;
const saved = {
  window: g.window,
  sessionStorage: g.sessionStorage,
  location: g.location,
  version: g.__OTACON_VERSION__,
};

let reloads: number;

/** A minimal sessionStorage backed by a Map — only the get/set this module uses. */
function fakeSessionStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

beforeEach(() => {
  reloads = 0;
  g.__OTACON_VERSION__ = "0.1.0";
  g.window = {} as unknown;
  g.sessionStorage = fakeSessionStorage();
  g.location = { reload: () => void (reloads += 1) } as unknown;
});

afterEach(() => {
  g.window = saved.window;
  g.sessionStorage = saved.sessionStorage;
  g.location = saved.location;
  g.__OTACON_VERSION__ = saved.version;
});

describe("maybeSelfHeal", () => {
  test("same version does not reload", () => {
    maybeSelfHeal("0.1.0");
    expect(reloads).toBe(0);
    expect((g.sessionStorage as Storage).getItem("otacon-reloaded-for")).toBeNull();
  });

  test("different version reloads once and sets the guard", () => {
    maybeSelfHeal("0.2.0");
    expect(reloads).toBe(1);
    expect((g.sessionStorage as Storage).getItem("otacon-reloaded-for")).toBe("0.2.0");
  });

  test("a second call for the same target does not reload again", () => {
    maybeSelfHeal("0.2.0");
    maybeSelfHeal("0.2.0");
    expect(reloads).toBe(1);
  });

  test("a new mismatching target after a prior reload reloads again", () => {
    maybeSelfHeal("0.2.0");
    maybeSelfHeal("0.3.0");
    expect(reloads).toBe(2);
    expect((g.sessionStorage as Storage).getItem("otacon-reloaded-for")).toBe("0.3.0");
  });

  test("empty daemon version does not reload", () => {
    maybeSelfHeal("");
    expect(reloads).toBe(0);
  });

  test("undefined daemon version does not reload", () => {
    maybeSelfHeal(undefined);
    expect(reloads).toBe(0);
  });

  test("no-ops outside a browser (no window)", () => {
    g.window = undefined;
    maybeSelfHeal("0.2.0");
    expect(reloads).toBe(0);
  });

  test("a throwing sessionStorage never reloads and never escapes", () => {
    g.sessionStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    } as unknown as Storage;
    expect(() => maybeSelfHeal("0.2.0")).not.toThrow();
    expect(reloads).toBe(0);
  });
});
