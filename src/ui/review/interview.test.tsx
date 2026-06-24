import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { InterviewPanel, orderZones } from "./interview.js";
import type { TranscriptEntry } from "../api";

const AT = "2026-06-21T00:00:00.000Z";

function entry(fields: Partial<TranscriptEntry>): TranscriptEntry {
  return { id: "q1", askedAt: AT, question: "why?", ...fields };
}

/** Render the open panel to static markup; effects are skipped, which is fine —
 *  the deep-link effect early-returns on a null target. */
function render(transcript: TranscriptEntry[], editable: boolean): string {
  return renderToStaticMarkup(
    createElement(InterviewPanel, {
      sessionId: "s1",
      transcript,
      open: true,
      onToggle: () => undefined,
      target: null,
      editable,
    }),
  );
}

const answered = entry({
  options: ["A", "B"],
  recommend: "A",
  answer: { answeredAt: AT, choice: "A" },
});

describe("InterviewPanel open zone", () => {
  test("an open editable entry renders the inline AnswerForm, not the awaiting line", () => {
    const html = render([entry({ options: ["A", "B"], recommend: "A" })], true);
    expect(html).toContain("grill-chips"); // the interactive form is mounted
    expect(html).not.toContain("iv-awaiting");
  });

  test("an open free-text editable entry renders the textarea", () => {
    const html = render([entry({})], true);
    expect(html).toContain("grill-text");
    expect(html).not.toContain("iv-awaiting");
  });

  test("an open entry in a read-only archive shows the awaiting line, no form", () => {
    const html = render([entry({ options: ["A", "B"] })], false);
    expect(html).toContain("iv-awaiting");
    expect(html).not.toContain("grill-chips");
  });

  test("multiple open questions render oldest-first (q1, q2, q3)", () => {
    const q1 = entry({ id: "q1", askedAt: "2026-06-21T00:00:01.000Z", options: ["A"] });
    const q2 = entry({ id: "q2", askedAt: "2026-06-21T00:00:02.000Z", options: ["A"] });
    const q3 = entry({ id: "q3", askedAt: "2026-06-21T00:00:03.000Z", options: ["A"] });
    const html = render([q3, q1, q2], true); // deliberately out of order
    expect(html.indexOf('data-iv="q1"')).toBeLessThan(html.indexOf('data-iv="q2"'));
    expect(html.indexOf('data-iv="q2"')).toBeLessThan(html.indexOf('data-iv="q3"'));
  });
});

describe("orderZones oldest-first", () => {
  test("both zones sort by askedAt ascending (not by answeredAt)", () => {
    const o1 = entry({ id: "q1", askedAt: "2026-06-21T00:00:01.000Z" });
    const o2 = entry({ id: "q2", askedAt: "2026-06-21T00:00:02.000Z" });
    // q3 was asked before q4 but answered AFTER it: ordering keys on askedAt.
    const a3 = entry({
      id: "q3",
      askedAt: "2026-06-21T00:00:03.000Z",
      answer: { answeredAt: "2026-06-21T02:00:00.000Z", choice: "A" },
    });
    const a4 = entry({
      id: "q4",
      askedAt: "2026-06-21T00:00:04.000Z",
      answer: { answeredAt: "2026-06-21T01:00:00.000Z", choice: "B" },
    });
    const { open, answered } = orderZones([o2, a4, o1, a3]);
    expect(open.map((e) => e.id)).toEqual(["q1", "q2"]);
    expect(answered.map((e) => e.id)).toEqual(["q3", "q4"]);
  });

  test("does not mutate the input transcript", () => {
    const input = [
      entry({ id: "q2", askedAt: "2026-06-21T00:00:02.000Z" }),
      entry({ id: "q1", askedAt: "2026-06-21T00:00:01.000Z" }),
    ];
    orderZones(input);
    expect(input.map((e) => e.id)).toEqual(["q2", "q1"]);
  });
});

describe("InterviewPanel answered zone", () => {
  test("an answered editable entry shows the answer echo and the undo control", () => {
    const html = render([answered], true);
    expect(html).toContain("settled-choice"); // the answer echo
    expect(html).toContain("grill-undo");
    // No always-on option list: the chips only appear inside AnswerForm on undo.
    expect(html).not.toContain("iv-options");
    expect(html).not.toContain("grill-chips");
  });

  test("an answered read-only entry shows the echo but no undo", () => {
    const html = render([answered], false);
    expect(html).toContain("settled-choice");
    expect(html).not.toContain("grill-undo");
  });
});

describe("InterviewPanel zone ordering", () => {
  test("with one open and one answered entry, the open card precedes the answered card", () => {
    const open = entry({ id: "q2", askedAt: "2026-06-22T00:00:00.000Z", options: ["A", "B"] });
    const html = render([answered, open], true);
    // The open zone renders first: its label and card come before the answered zone.
    expect(html.indexOf("iv-zone-open")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("iv-zone-open")).toBeLessThan(html.indexOf("iv-zone-answered"));
    expect(html.indexOf('data-iv="q2"')).toBeLessThan(html.indexOf('data-iv="q1"'));
    // The divider sits between the two non-empty zones.
    expect(html).toContain("iv-divider");
  });

  test("a single zone renders no divider", () => {
    expect(render([answered], true)).not.toContain("iv-divider");
  });
});
