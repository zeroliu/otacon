import { describe, expect, test } from "bun:test";
import type { UiEvent } from "./notify.js";
import { Notifier } from "./notify.js";

const queueEvent = (session: string): UiEvent => ({
  type: "queue",
  session,
  data: { session, pending: 1 },
});

describe("Notifier", () => {
  test("delivers published events to every subscriber, in order", () => {
    const notifier = new Notifier();
    const seenA: Array<string | null> = [];
    const seenB: Array<string | null> = [];
    notifier.subscribe((e) => seenA.push(e.session));
    notifier.subscribe((e) => seenB.push(e.session));
    notifier.publish(queueEvent("otc_aaaaaa"));
    notifier.publish(queueEvent("otc_bbbbbb"));
    expect(seenA).toEqual(["otc_aaaaaa", "otc_bbbbbb"]);
    expect(seenB).toEqual(["otc_aaaaaa", "otc_bbbbbb"]);
  });

  test("unsubscribe stops delivery without touching other subscribers", () => {
    const notifier = new Notifier();
    const kept: Array<string | null> = [];
    const dropped: Array<string | null> = [];
    notifier.subscribe((e) => kept.push(e.session));
    const unsubscribe = notifier.subscribe((e) => dropped.push(e.session));
    notifier.publish(queueEvent("otc_one111"));
    unsubscribe();
    notifier.publish(queueEvent("otc_two222"));
    expect(kept).toEqual(["otc_one111", "otc_two222"]);
    expect(dropped).toEqual(["otc_one111"]);
  });
});
