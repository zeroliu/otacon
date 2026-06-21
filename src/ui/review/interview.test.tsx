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

describe("InterviewPanel change affordance", () => {
  test("an answered entry shows the change control while editable", () => {
    expect(render([answered], true)).toContain("grill-change");
  });

  test("a read-only session shows no change control", () => {
    const html = render([answered], false);
    expect(html).not.toContain("grill-change");
    // the static answer block is still there — read-only is byte-for-byte today
    expect(html).toContain("iv-answer");
  });

  test("an unanswered entry never shows the change control, even editable", () => {
    const pending = entry({ options: ["A", "B"] });
    const html = render([pending], true);
    expect(html).not.toContain("grill-change");
    expect(html).toContain("iv-awaiting");
  });
});
