import { describe, expect, test } from "bun:test";
import { Presence } from "./presence.js";

/** A hand-cranked clock so expiry is deterministic, never wall-time-dependent. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe("Presence", () => {
  test("a marked-visible session is watched", () => {
    const presence = new Presence();
    expect(presence.isWatched("otc_a")).toBe(false);
    presence.markVisible("otc_a");
    expect(presence.isWatched("otc_a")).toBe(true);
  });

  test("an explicit hidden ping un-suppresses immediately", () => {
    const presence = new Presence();
    presence.markVisible("otc_a");
    presence.markHidden("otc_a");
    expect(presence.isWatched("otc_a")).toBe(false);
  });

  test("a stale heartbeat expires after the TTL (crashed/closed tab)", () => {
    const c = clock();
    const presence = new Presence(c.now, 45_000);
    presence.markVisible("otc_a");
    c.advance(44_999);
    expect(presence.isWatched("otc_a")).toBe(true);
    c.advance(1);
    expect(presence.isWatched("otc_a")).toBe(false);
  });

  test("a heartbeat within the window keeps the session watched", () => {
    const c = clock();
    const presence = new Presence(c.now, 45_000);
    presence.markVisible("otc_a");
    c.advance(30_000);
    presence.markVisible("otc_a"); // heartbeat
    c.advance(30_000);
    expect(presence.isWatched("otc_a")).toBe(true); // 30s since last beat < TTL
  });

  test("presence is per-session", () => {
    const presence = new Presence();
    presence.markVisible("otc_a");
    expect(presence.isWatched("otc_a")).toBe(true);
    expect(presence.isWatched("otc_b")).toBe(false);
  });
});
