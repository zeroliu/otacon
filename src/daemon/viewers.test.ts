import { describe, expect, test } from "bun:test";
import { Viewers } from "./viewers.js";

/** A hand-cranked clock so expiry is deterministic, never wall-time-dependent. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("Viewers", () => {
  test("a beating client counts as one live viewer", () => {
    const viewers = new Viewers();
    expect(viewers.count()).toBe(0);
    viewers.beat("tab-a");
    expect(viewers.count()).toBe(1);
  });

  test("a second client counts independently", () => {
    const viewers = new Viewers();
    viewers.beat("tab-a");
    viewers.beat("tab-b");
    expect(viewers.count()).toBe(2);
    viewers.beat("tab-a"); // re-beat is idempotent on the count
    expect(viewers.count()).toBe(2);
  });

  test("a stale client expires after the TTL (closed/crashed tab)", () => {
    const c = clock();
    const viewers = new Viewers(c.now, 90_000);
    viewers.beat("tab-a");
    c.advance(89_999);
    expect(viewers.count()).toBe(1);
    c.advance(1);
    expect(viewers.count()).toBe(0);
  });

  test("a fresh beat within the window keeps the client live", () => {
    const c = clock();
    const viewers = new Viewers(c.now, 90_000);
    viewers.beat("tab-a");
    c.advance(60_000);
    viewers.beat("tab-a"); // heartbeat
    c.advance(60_000);
    expect(viewers.count()).toBe(1); // 60s since last beat < TTL
  });

  test("a `gone` drop removes the client immediately", () => {
    const viewers = new Viewers();
    viewers.beat("tab-a");
    expect(viewers.count()).toBe(1);
    viewers.drop("tab-a");
    expect(viewers.count()).toBe(0);
  });

  test("one expiring client does not drop a still-live one", () => {
    const c = clock();
    const viewers = new Viewers(c.now, 90_000);
    viewers.beat("tab-a");
    c.advance(50_000);
    viewers.beat("tab-b");
    c.advance(50_000); // tab-a is now 100s stale, tab-b only 50s
    expect(viewers.count()).toBe(1);
  });
});
