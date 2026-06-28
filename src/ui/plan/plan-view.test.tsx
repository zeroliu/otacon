// Phase-field IA pins (review UI): the canonical render order and the Files
// field's labelless, full-width treatment. orderedFields is the pure rank sort
// (Goal, Verification, Out of scope, Files-last) tested directly; the render
// assertion mounts a phase through PlanView's real markdown pipeline and checks
// the Files row carries no .field-label while the other fields do.
//
// PlanView -> Markdown -> DOMPurify, and DOMPurify binds `window` at *import*
// time (it returns a no-op sanitize when window is absent). So the happy-dom
// globals are installed at module top level and PlanView is pulled in via a
// dynamic import below that line — guaranteeing a real DOM by the time
// dompurify's module factory runs.

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanField } from "./parse.js";

const win = new Window();
const g = globalThis as { document?: unknown; window?: unknown };
g.document = win.document;
g.window = win;

// Imported after the globals are live (see header) so dompurify wires up.
const { default: PlanView, orderedFields } = await import("./plan-view.js");

const field = (key: PlanField["key"], label: string): PlanField => ({
  key,
  label,
  blocks: [{ kind: "markdown", text: `${label} content` }],
});

describe("orderedFields", () => {
  test("sorts source order [files, goal, verification] to [goal, verification, files]", () => {
    const out = orderedFields([
      field("files", "Files"),
      field("goal", "Goal"),
      field("verification", "Verification"),
    ]);
    expect(out.map((f) => f.key)).toEqual(["goal", "verification", "files"]);
  });

  test("out-of-scope sorts between verification and files", () => {
    const out = orderedFields([
      field("files", "Files"),
      field("out-of-scope", "Out of scope"),
      field("verification", "Verification"),
      field("goal", "Goal"),
    ]);
    expect(out.map((f) => f.key)).toEqual(["goal", "verification", "out-of-scope", "files"]);
  });

  test("is a pure sort — does not mutate its input", () => {
    const input = [field("files", "Files"), field("goal", "Goal")];
    const snapshot = input.map((f) => f.key);
    orderedFields(input);
    expect(input.map((f) => f.key)).toEqual(snapshot);
  });

  test("Files always lands last", () => {
    expect(
      orderedFields([field("files", "Files"), field("goal", "Goal")]).map((f) => f.key).at(-1),
    ).toBe("files");
  });
});

const PLAN = `# Title

## Phases

### Phase 1 — Do the thing

Goal: ship it
Verification: tests pass
Files:

| File | What changed |
| --- | --- |
| \`src/foo.ts\` | new module |
`;

describe("PhaseCard field rendering", () => {
  test("the files field renders no .field-label; goal and verification keep theirs", () => {
    const html = renderToStaticMarkup(createElement(PlanView, { markdown: PLAN, warnings: [] }));
    // The Files row exists and is full-width-targetable...
    expect(html).toContain('class="field field-files"');
    // ...but carries no eyebrow label (label removed for both list and table).
    expect(html).not.toContain(">FILES<");
    expect(html).not.toContain(">Files<");
    // The labelled fields still print their <dt class="field-label">.
    expect(html).toContain('class="field field-goal"');
    expect(html).toContain('class="field field-verification"');
    expect(html).toContain('<dt class="field-label">Goal</dt>');
    expect(html).toContain('<dt class="field-label">Verification</dt>');
  });

  test("Files renders after Verification regardless of source order", () => {
    const html = renderToStaticMarkup(createElement(PlanView, { markdown: PLAN, warnings: [] }));
    expect(html.indexOf("field-verification")).toBeLessThan(html.indexOf("field-files"));
  });
});
