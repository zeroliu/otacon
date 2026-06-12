import { describe, expect, test } from "bun:test";
import type { Anchor } from "../shared/types.js";
import { normalize, relocateAnchor } from "./anchor.js";
import { segmentPlan } from "./diff.js";

const plan = (body: string): string => `---
title: t
session: otc_test01
revision: 2
status: in_review
created: 2026-06-13
---

${body}`;

const BASE = plan(`## Summary

Replace session auth with short-lived JWTs issued by the auth service.

## Decisions

- D1: RS256 over HS256 ← q7
- D2: Sessions table stays until phase 3 [assumed]

## Phases

### Phase 1 — Token issuance

Goal: Issue RS256 JWTs from the auth service.
Files:
- src/auth/issuer.ts
Verification: Unit tests cover issuance and key rotation.

### Phase 2 — Middleware

Goal: Verify JWTs in the API middleware.
Files:
- src/middleware/jwt.ts
Verification: Integration tests hit a protected route.

## Risks

- Clock skew between issuer and verifiers may reject fresh tokens.

## Open Questions

- None.`);

const anchor = (section: string, exact?: string, extra: Partial<Anchor> = {}): Anchor => ({
  section,
  ...(exact !== undefined ? { exact } : {}),
  ...extra,
});

describe("normalize", () => {
  test("collapses whitespace runs and strips markdown markers, with a raw-index map", () => {
    const { text, map } = normalize("**Goal:**  Verify\n\tJWTs");
    expect(text).toBe("Goal: Verify JWTs");
    // The map points each normalized char at a raw index; spot-check ends.
    expect(map).toHaveLength(text.length);
    expect("**Goal:**  Verify\n\tJWTs"[map[0] as number]).toBe("G");
    expect("**Goal:**  Verify\n\tJWTs"[map[text.length - 1] as number]).toBe("s");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalize("  a  b  ").text).toBe("a b");
    expect(normalize("***").text).toBe("");
    expect(normalize("").text).toBe("");
  });
});

describe("relocateAnchor: section-only anchors", () => {
  test("survive while the section exists, orphan when it is gone", () => {
    expect(relocateAnchor(anchor("phase-2"), BASE).state).toBe("anchored");
    const withoutP2 = plan(BASE.split("### Phase 2")[0] as string)
      .replace(/\n$/, "\n## Risks\n\n- r.\n\n## Open Questions\n\n- None.\n");
    expect(relocateAnchor(anchor("phase-2"), withoutP2).state).toBe("orphaned");
  });
});

describe("relocateAnchor: exact matches", () => {
  test("an untouched quote stays anchored in place", () => {
    const result = relocateAnchor(anchor("decisions", "RS256 over HS256"), BASE);
    expect(result).toEqual({
      state: "anchored",
      anchor: anchor("decisions", "RS256 over HS256"),
    });
  });

  test("pre-segmented units give the same answer as the per-call parse", () => {
    // applyRevisionToThreads segments the plan once for a whole rail of threads.
    const units = segmentPlan(BASE);
    const a = anchor("decisions", "RS256 over HS256");
    expect(relocateAnchor(a, BASE, units)).toEqual(relocateAnchor(a, BASE));
  });

  test("moved text re-anchors to its new section", () => {
    // The decision moves wholesale into phase 1's goal.
    const moved = BASE.replace("- D1: RS256 over HS256 ← q7\n", "").replace(
      "Goal: Issue RS256 JWTs from the auth service.",
      "Goal: D1: RS256 over HS256 ← q7.",
    );
    const result = relocateAnchor(anchor("decisions", "RS256 over HS256"), moved);
    expect(result.state).toBe("anchored");
    expect(result.state === "anchored" && result.anchor.section).toBe("phase-1");
    expect(result.state === "anchored" && result.anchor.exact).toBe("RS256 over HS256");
  });

  test("an edited quote orphans — the text the user discussed is gone", () => {
    const edited = BASE.replace("RS256 over HS256", "ES256 over HS256");
    expect(relocateAnchor(anchor("decisions", "RS256 over HS256"), edited).state).toBe("orphaned");
  });

  test("a deleted section orphans its quoted thread", () => {
    const without = BASE.replace("- D1: RS256 over HS256 ← q7\n", "");
    expect(relocateAnchor(anchor("decisions", "RS256 over HS256"), without).state).toBe(
      "orphaned",
    );
  });
});

describe("relocateAnchor: duplicated text", () => {
  const DUPED = BASE.replace(
    "Verification: Integration tests hit a protected route.",
    "Verification: Unit tests cover issuance and key rotation.",
  );

  test("prefix/suffix context disambiguates duplicates", () => {
    const result = relocateAnchor(
      anchor("phase-2", "tests cover issuance", {
        prefix: "Verify JWTs in the API middleware",
      }),
      DUPED,
    );
    expect(result.state).toBe("anchored");
    expect(result.state === "anchored" && result.anchor.section).toBe("phase-2");
  });

  test("without context, a duplicate in the original section wins", () => {
    const result = relocateAnchor(anchor("phase-1", "tests cover issuance"), DUPED);
    expect(result.state).toBe("anchored");
    expect(result.state === "anchored" && result.anchor.section).toBe("phase-1");
  });

  test("ambiguous duplicates orphan rather than guess", () => {
    // Two occurrences, no usable context, anchor's section names neither
    // (the quote left its original section entirely).
    const result = relocateAnchor(anchor("summary", "tests cover issuance"), DUPED);
    expect(result.state).toBe("orphaned");
  });

  test("duplicates within one section orphan without distinguishing context", () => {
    const twice = BASE.replace(
      "- Clock skew between issuer and verifiers may reject fresh tokens.",
      "- Clock skew may reject fresh tokens.\n- Clock skew may reject fresh tokens.",
    );
    expect(relocateAnchor(anchor("risks", "Clock skew may reject"), twice).state).toBe("orphaned");
  });
});

describe("relocateAnchor: fuzzy (normalized) matches", () => {
  test("whitespace reflow still anchors and rewrites the quote to the new raw text", () => {
    const reflowed = BASE.replace(
      "Replace session auth with short-lived JWTs issued by the auth service.",
      "Replace session auth with short-lived\nJWTs issued by the auth service.",
    );
    const result = relocateAnchor(
      anchor("summary", "short-lived JWTs issued by the auth service"),
      reflowed,
    );
    expect(result.state).toBe("anchored");
    if (result.state === "anchored") {
      expect(result.anchor.section).toBe("summary");
      expect(result.anchor.exact).toBe("short-lived\nJWTs issued by the auth service");
      // Context is a hint, not a contract — 32 raw chars, normalized.
      expect(result.anchor.prefix).toContain("Replace session auth with");
    }
  });

  test("emphasis markers added around the quoted text are forgiven", () => {
    const bolded = BASE.replace("RS256 over HS256", "**RS256** over `HS256`");
    const result = relocateAnchor(anchor("decisions", "RS256 over HS256"), bolded);
    expect(result.state).toBe("anchored");
    // The rewritten quote is the raw span between the first and last matched
    // chars — flanking markers fall outside it, internal ones stay (greppable
    // verbatim in plan.md either way).
    expect(result.state === "anchored" && result.anchor.exact).toBe("RS256** over `HS256");
  });

  test("a quote captured from rendered bold text matches the marked-up source", () => {
    // The UI quotes rendered text ("Goal: Verify…"), the plan says "**Goal:**".
    const styled = BASE.replace(
      "Goal: Verify JWTs in the API middleware.",
      "**Goal:** Verify JWTs in the API middleware.",
    );
    const result = relocateAnchor(
      anchor("phase-2", "Goal: Verify JWTs in the API middleware."),
      styled,
    );
    expect(result.state).toBe("anchored");
    expect(result.state === "anchored" && result.anchor.section).toBe("phase-2");
  });

  test("a quote that is only markers orphans instead of matching everywhere", () => {
    expect(relocateAnchor(anchor("summary", "**`__`**"), BASE).state).toBe("orphaned");
  });
});
