// Pins the sidebar collapse persistence contract (app shell): the flag
// round-trips through localStorage, defaults to expanded (false) when unset, and
// reads tolerate a throwing or absent store without crashing — the same
// "storage may be hostile" rule seen.ts and the renderer-reload guard follow. No
// DOM library needed: we stub the one global the module touches (localStorage)
// with a Map-backed fake, exactly like self-heal.test.ts stubs sessionStorage.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./sidebar-state.js";

const g = globalThis as Record<string, unknown>;
const saved = { localStorage: g.localStorage };

/** A minimal localStorage backed by a Map — only the get/set/remove this module uses. */
function fakeLocalStorage(): Storage {
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
  g.localStorage = fakeLocalStorage();
});

afterEach(() => {
  g.localStorage = saved.localStorage;
});

describe("sidebar collapse persistence", () => {
  test("defaults to expanded (not collapsed) when nothing is stored", () => {
    expect(readSidebarCollapsed()).toBe(false);
  });

  test("write(true) → read(true) round-trips the collapsed flag", () => {
    writeSidebarCollapsed(true);
    expect(readSidebarCollapsed()).toBe(true);
  });

  test("write(false) clears back to the expanded default", () => {
    writeSidebarCollapsed(true);
    writeSidebarCollapsed(false);
    expect(readSidebarCollapsed()).toBe(false);
  });

  test("a throwing store reads as the expanded default and never escapes", () => {
    g.localStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
      removeItem: () => {
        throw new Error("storage disabled");
      },
    } as unknown as Storage;
    expect(() => readSidebarCollapsed()).not.toThrow();
    expect(readSidebarCollapsed()).toBe(false);
    // a write against a hostile store must also swallow, not throw
    expect(() => writeSidebarCollapsed(true)).not.toThrow();
  });

  test("an absent store reads as the expanded default and never escapes", () => {
    g.localStorage = undefined;
    expect(() => readSidebarCollapsed()).not.toThrow();
    expect(readSidebarCollapsed()).toBe(false);
    expect(() => writeSidebarCollapsed(true)).not.toThrow();
  });
});
