import { afterEach, describe, expect, test } from "bun:test";
import { fetchLatest, isNewer, type UpdateCache, updateCheckDue } from "./update.js";

describe("isNewer", () => {
  test("a strictly greater patch is newer", () => {
    expect(isNewer("0.1.2", "0.1.1")).toBe(true);
    expect(isNewer("0.1.1", "0.1.2")).toBe(false);
  });

  test("equal versions are not newer", () => {
    expect(isNewer("0.1.1", "0.1.1")).toBe(false);
  });

  test("an older version is not newer", () => {
    expect(isNewer("0.1.0", "0.2.5")).toBe(false);
  });

  test("minor outranks patch (0.2.0 > 0.1.9)", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
  });

  test("major outranks minor and patch (1.0.0 > 0.9.9)", () => {
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  });

  test("a leading v and a prerelease suffix are tolerated", () => {
    expect(isNewer("v0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.2.0-beta.1", "0.1.0")).toBe(true);
  });

  test("a malformed version on either side is never newer", () => {
    expect(isNewer("garbage", "0.1.1")).toBe(false);
    expect(isNewer("0.1.2", "nope")).toBe(false);
    expect(isNewer("0.1", "0.1.1")).toBe(false);
    expect(isNewer("0.1.2.3", "0.1.1")).toBe(false);
    expect(isNewer("", "0.1.1")).toBe(false);
  });
});

describe("updateCheckDue", () => {
  const now = 10_000_000_000;
  const hour = 3_600_000;

  test("a fresh check (10 min ago) is not due", () => {
    expect(updateCheckDue({ checkedAt: now - 10 * 60_000 }, now)).toBe(false);
  });

  test("a stale check (2h ago) is due", () => {
    expect(updateCheckDue({ checkedAt: now - 2 * hour }, now)).toBe(true);
  });

  test("an absent cache is due", () => {
    expect(updateCheckDue(undefined, now)).toBe(true);
  });

  test("exactly the window boundary is due (>=)", () => {
    expect(updateCheckDue({ checkedAt: now - hour }, now)).toBe(true);
    expect(updateCheckDue({ checkedAt: now - hour + 1 }, now)).toBe(false);
  });

  test("a malformed checkedAt is treated as due", () => {
    expect(updateCheckDue({ checkedAt: Number.NaN }, now)).toBe(true);
    expect(updateCheckDue({ checkedAt: "soon" } as unknown as UpdateCache, now)).toBe(true);
  });

  test("a custom window is honored", () => {
    expect(updateCheckDue({ checkedAt: now - 90_000 }, now, 60_000)).toBe(true);
    expect(updateCheckDue({ checkedAt: now - 30_000 }, now, 60_000)).toBe(false);
  });
});

describe("fetchLatest", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(impl: () => Promise<Response>): void {
    globalThis.fetch = (() => impl()) as unknown as typeof fetch;
  }

  test("returns the version from a 200 JSON body", async () => {
    stubFetch(async () => new Response(JSON.stringify({ version: "0.3.0" }), { status: 200 }));
    expect(await fetchLatest()).toBe("0.3.0");
  });

  test("returns undefined on a non-200 response", async () => {
    stubFetch(async () => new Response("not found", { status: 404 }));
    expect(await fetchLatest()).toBeUndefined();
  });

  test("returns undefined when fetch rejects (network/timeout)", async () => {
    stubFetch(async () => {
      throw new Error("network down");
    });
    expect(await fetchLatest()).toBeUndefined();
  });

  test("returns undefined on a malformed JSON body", async () => {
    stubFetch(async () => new Response("{not json", { status: 200 }));
    expect(await fetchLatest()).toBeUndefined();
  });

  test("returns undefined when version is missing or empty", async () => {
    stubFetch(async () => new Response(JSON.stringify({ name: "otacon" }), { status: 200 }));
    expect(await fetchLatest()).toBeUndefined();
    stubFetch(async () => new Response(JSON.stringify({ version: "" }), { status: 200 }));
    expect(await fetchLatest()).toBeUndefined();
  });

  test("passes a provided AbortSignal through to fetch", async () => {
    let seen: AbortSignal | undefined;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return Promise.resolve(new Response(JSON.stringify({ version: "0.4.0" }), { status: 200 }));
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    expect(await fetchLatest(controller.signal)).toBe("0.4.0");
    expect(seen).toBe(controller.signal);
  });
});
