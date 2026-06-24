// Phase 4 (verify-before-merge): the rendered-output regression class. A grill
// question whose text spans multiple paragraphs / line breaks must RENDER with
// those breaks preserved — the motivating failure was a question rendering as
// one run-on blob (collapsed whitespace), where a styling "fix" shipped without
// anyone verifying the actual rendered output changed. `.grill-question` carries
// `white-space: pre-wrap` for exactly this; this spec gates that behavior so a
// regression (dropping pre-wrap) fails CI instead of reaching a reviewer.
//
// The assertion is behavioral, not a snapshot of the CSS value: a multi-line
// question is measured against a single-line one in the SAME render, so a
// collapse (every newline → a space → one line) shrinks the multi-line height
// to ~the single-line height and trips the ratio check. The computed-white-space
// assertion pins the precise mechanism on top.

import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { createSession, uniqueTitle } from "./helpers.js";

/** POST /ask through the real API; returns the minted q<n> id. */
async function ask(
  request: APIRequestContext,
  id: string,
  question: string,
): Promise<string> {
  const res = await request.post(`/api/sessions/${id}/ask`, { data: { question } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

interface Measured {
  height: number;
  whiteSpace: string;
  text: string;
}

/** Measure the rendered question paragraph for a card — height + the computed
 *  white-space + its text. String-expression evaluate keeps DOM types out of
 *  the server tsconfig (the helpers.ts convention). */
async function measure(
  page: import("@playwright/test").Page,
  qid: string,
): Promise<Measured> {
  const m = await page.evaluate(
    `(() => {
      const el = document.querySelector('.grill-card[data-iv="${qid}"] .grill-question');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        height: el.getBoundingClientRect().height,
        whiteSpace: cs.whiteSpace,
        text: el.textContent || "",
      };
    })()`,
  );
  expect(m, `no rendered .grill-question for ${qid}`).not.toBeNull();
  return m as Measured;
}

test("a multi-paragraph question renders with its line breaks preserved, not collapsed", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("question-linebreaks"));

  // Both questions land as open cards in the default-expanded Interview panel
  // (zero revisions = pre-plan grill). Short phrases so neither wraps on its own
  // at desktop width — any extra height on the multi comes from real newlines.
  const single = await ask(request, session.id, "Single line question.");
  const multi = await ask(
    request,
    session.id,
    "Paragraph one.\n\nParagraph two.\nLine inside two.",
  );

  await page.goto(`/s/${session.id}`);
  await expect(page.locator(`.grill-card[data-iv="${single}"]`)).toBeVisible();
  await expect(page.locator(`.grill-card[data-iv="${multi}"]`)).toBeVisible();

  const oneLine = await measure(page, single);
  const manyLines = await measure(page, multi);

  // Mechanism: the question paragraph preserves whitespace (pre-wrap / pre-line /
  // pre / break-spaces). A regression to `normal` collapses the breaks.
  expect(manyLines.whiteSpace).toMatch(/^(pre|pre-wrap|pre-line|break-spaces)$/);

  // Behavior (the real rendered-output check): the multi-paragraph question is
  // materially TALLER than the single-line one. Its text is 4 visual rows
  // ("Paragraph one." / blank / "Paragraph two." / "Line inside two."), so with
  // breaks preserved it is roughly 4x; collapsed it would be ~1x. 2.5x is a
  // safe floor that a collapse cannot clear.
  expect(manyLines.height).toBeGreaterThan(oneLine.height * 2.5);

  // Sanity: the content itself survived (text content alone would survive a
  // collapse too, which is why height — not text — is the regression guard).
  expect(manyLines.text).toContain("Paragraph one.");
  expect(manyLines.text).toContain("Line inside two.");
});
