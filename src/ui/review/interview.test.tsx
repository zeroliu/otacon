import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { InterviewPanel } from "./interview.js";
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
