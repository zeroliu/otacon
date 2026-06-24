import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Ledger } from "../../shared/types";
import type { FenceBlock } from "./parse";
import { ScenarioCards } from "./scenario-card";

// Two scenarios in one gwt fence — flat indices 0 and 1 within the phase.
const fence: FenceBlock = {
  kind: "fence",
  lang: "gwt",
  tags: [],
  code: [
    "Given a token request",
    "When the agent runs it",
    "Then it passes",
    "",
    "Given a rotated key",
    "When the agent runs it",
    "Then it passes",
  ].join("\n"),
};

function render(props: { phase?: number; base?: number; ledger?: Ledger }): string {
  return renderToStaticMarkup(createElement(ScenarioCards, { fence, ...props }));
}

describe("ScenarioCards verify-before-merge badge", () => {
  test("no ledger → no badge (a pre-implementation plan is unchanged)", () => {
    const html = render({ phase: 1 });
    expect(html).not.toContain("gwt-badge");
    // The scenarios still render.
    expect(html).toContain("a token request");
    expect(html).toContain("a rotated key");
  });

  test("a 'pass' entry renders a 'verified' badge with the evidence as a tooltip", () => {
    const ledger: Ledger = {
      1: { 0: { status: "pass", evidence: "issuance test green" } },
    };
    const html = render({ phase: 1, ledger });
    expect(html).toContain("gwt-badge-verified");
    expect(html).toContain(">verified<");
    expect(html).toContain('title="issuance test green"');
    // Only scenario 0 is attested; scenario 1 carries no badge.
    expect(html).not.toContain("gwt-badge-skipped");
  });

  test("a 'skip' entry renders a 'skipped' badge", () => {
    const ledger: Ledger = {
      1: { 1: { status: "skip", evidence: "rotation deferred, tracked in #12" } },
    };
    const html = render({ phase: 1, ledger });
    expect(html).toContain("gwt-badge-skipped");
    expect(html).toContain(">skipped<");
    expect(html).toContain('title="rotation deferred, tracked in #12"');
  });

  test("the flat index honours `base` — a fence later in the same phase keys off base + i", () => {
    // This fence's two scenarios are flat indices 3 and 4 (base 3): the badge
    // must read ledger[phase][3]/[4], matching the daemon's flat-index convention.
    const ledger: Ledger = {
      1: { 3: { status: "pass", evidence: "covered at index three" } },
    };
    const html = render({ phase: 1, base: 3, ledger });
    expect(html).toContain("gwt-badge-verified");
    expect(html).toContain('title="covered at index three"');
  });
});
