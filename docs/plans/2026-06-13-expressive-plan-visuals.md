---
title: expressive-plan-visuals
session: otc_zozt08
revision: 1
status: approved
created: 2026-06-13
---

# expressive-plan-visuals

## Summary

Plans render with codec styling but read as walls of prose — the agent rarely
reaches for a visual. Add three markdown-native, comment-anchorable primitives
that aid review — semantic callouts, decision matrices, inline scope pills —
plus wrapper-prompt guidance that pushes their use. They degrade to plain
markdown, stay budget-capped (no wall of widgets), and never call a model.

## Decisions

- D1: Ship both new render primitives AND a wrapper-prompt push, not one alone ← q1
- D2: v1 primitives = semantic callouts, decision matrix, inline scope pills ← q2
- D3: Author them in plain markdown (no fenced DSLs) so every element stays
  comment-anchorable, line-budget-aware, and degrades to readable markdown ← q3
- D4: Drop the blast-radius file tree from v1 — the one primitive that needed a
  fenced DSL; cutting it keeps the set cleanly markdown-native ← q3
- D5: Encode type with semantic ink — a 2px top rule + a glyph in a hue per type
  (the §10 accent-mark vocabulary), no fills, no radius ← q4
- D6: Visuals are budget-exempt but count-capped per read-path section (tunable,
  like the 1-fence rule); inline pills are always free ← q5
- D7: Push adoption via wrapper guidance + soft SHOULDs, no lint enforcement —
  avoids cargo-culted decoration ← q6
- D8: One milestone, phased by primitive; each phase a shippable commit ← q7

## Phases

### Phase 1 — Callout primitive (vertical slice)

Goal: Render `> [!risk|note|decision|assumption]` blockquotes as flat
semantic-ink callout panels (2px top rule + glyph, hue per type, no fill).
Establish the shared render + budget pattern the later primitives reuse.
Files:
- src/ui/plan/callout.tsx (new — blockquote→callout transform)
- src/ui/plan/markdown.tsx (wire the transform before DOMPurify)
- src/ui/styles.css (callout panels, semantic hues, light/dark)
- src/daemon/linter/parse.ts (detect callouts; exempt their lines, count them)
- src/daemon/linter/rules.ts (per-section visual cap)
- src/shared/config.ts (maxVisualsPerReadSection budget)
- src/ui/plan/callout.test.ts, src/daemon/linter/parse.test.ts, lint.test.ts (cases)
Verification: bun test (render + parser exemption + cap); a 4-type sample plan
renders correctly in the browser; an over-cap section fails lint.

#### Details

The transform keys off a blockquote whose first line is `[!type]` with `type`
in a closed set; unknown types fall through to a plain blockquote. The marker
line is consumed (renderer chrome, no anchor toolbar — §10); the body text stays
in both markdown and DOM, so comments anchor to a specific callout. The class
(e.g. `callout callout-risk`) survives DOMPurify; no inline styles are emitted.

The point — a risk should stop being one bullet among many:

```md before
- Risk: the JWT migration locks out sessions issued before the cutover.
```

```md after
> [!risk]
> The JWT migration locks out sessions issued before the cutover.
```

### Phase 2 — Decision matrix

Goal: Style GFM tables as codec decision matrices; a row whose first cell is the
chosen-marker (`✓`) gets accent-inked `chosen` styling. Budget-exempt + counted
against the visual cap; degrades to a plain table.
Files:
- src/ui/plan/markdown.tsx (table renderer override + chosen-row class)
- src/ui/styles.css (matrix table, chosen row)
- src/daemon/linter/parse.ts (table detection; exempt + count)
- src/daemon/linter/parse.test.ts, src/ui/plan/markdown.test.ts (cases)
Verification: bun test; a decisions table with a ✓ row highlights the winner;
table lines don't blow the section line budget and do count toward the cap.

### Phase 3 — Inline scope pills

Goal: Transform a closed set of inline tokens (`[new] [breaking] [risky]
[deletes]`) into codec pills. Never touch markdown links or the existing
`[assumed]` decision tag; pills are always budget-free.
Files:
- src/ui/plan/markdown.tsx (inline token transform)
- src/ui/plan/plan-view.tsx (order vs markDecisionTraces / [assumed])
- src/ui/styles.css (pill chip)
- src/ui/plan/markdown.test.ts (links + [assumed] untouched; anchor span)
Verification: bun test; pills render inline; links and `[assumed]` unaffected;
a selection spanning a pill still resolves an anchor (or the limit is documented).

### Phase 4 — Wrapper prompt + docs

Goal: Add a "Visuals" subsection to the protocol card teaching the three
primitives with examples + soft SHOULD rules (matrix for 2+ weighed options;
callouts for risks/assumptions). Update the spec and decision record together.
Files:
- src/cli/install/assets.ts (the protocol card — canonical wrapper text)
- .claude/skills/otacon/SKILL.md (dogfood copy, kept in sync)
- DESIGN.md (§4 visuals, §10 callout/matrix/pill treatment)
- DECISIONS.md (markdown-native, semantic-ink, budget-cap rationale)
- README.md (Roadmap line)
Verification: assets snapshot/round-trip test passes; DESIGN + DECISIONS land in
the same commit; manual read-through of the rendered card.

## Risks

- R1: Pills rewrite inline text (brackets dropped in DOM), which can break
  anchoring for a selection spanning a pill — verify vs anchor.ts in P3.
- R2: Budget-exemption is a smuggling vector (prose hidden in callouts) — the
  per-section count cap + normative/informative contract are the guardrail.
- R3: marked has no native alert support; the blockquote transform must run
  pre-DOMPurify and keep its `class` through sanitization.
- R4: Semantic hues must hold contrast in light + dark and not clash with the
  per-session accent — draw from a tested codec palette.
- R5: Four phases may run long; each is independently shippable, so we can stop
  or re-scope after any phase.

## Open Questions

- Confirm/trim the callout vocabulary (risk/note/decision/assumption) and the
  pill keyword set (new/breaking/risky/deletes).
- Default visual cap per read-path section — proposed 2, tune in first-week use.
- Chosen-marker convention for the matrix — `✓` first cell vs an alternative.

## Interview

### q1 — The core problem: the rendered plan looks nice (codec aesthetic) but the agent still writes a wall of prose+bullets. What's the primary lever for this milestone?

- Options: Both: add a focused set of new review-oriented visual primitives AND teach the agent (prompt) to use them (recommended) | Prompt-only: teach the agent to use the EXISTING vocab (mermaid, tables, before/after, wireframes) far more aggressively, no renderer code | Renderer-only: add primitives but leave the wrapper prompt as-is
- Answer: Both: add a focused set of new review-oriented visual primitives AND teach the agent (prompt) to use them

### q2 — Which new review-oriented primitives should we consider for v1? Pick the set; we'll size/cut it in a later question. My recommended v1 core is Callouts + Blast-radius file tree — highest review value, lowest cost, both fit the hairline/codec look. (All render deterministically; no model calls.)

- Options (multi): Callouts: risk / note / decision / assumption — blockquote-native, anchorable, makes key flags pop out of prose (recommended) | Blast-radius file tree: touched files rendered as a tree with new / edit / delete markers — answers 'what does this touch?' at a glance | Decision matrix: chosen vs rejected options in a compact table, winner marked — tradeoffs at a glance | Inline scope pills: [new] [breaking] [risky] tokens rendered as small codec tags inline in prose | Phase dependency strip: auto-rendered phase order / depends-on map (lighter than a full mermaid diagram)
- Answer: Callouts: risk / note / decision / assumption — blockquote-native, anchorable, makes key flags pop out of prose, Decision matrix: chosen vs rejected options in a compact table, winner marked — tradeoffs at a glance, Blast-radius file tree: touched files rendered as a tree with new / edit / delete markers — answers 'what does this touch?' at a glance, Inline scope pills: [new] [breaking] [risky] tokens rendered as small codec tags inline in prose

### q3 — How should the agent author these visuals? This decides whether you can pin a comment to a SPECIFIC element (one risk, one file, one matrix row) vs only the whole section. (The file-tree is a special case we'll settle right after.)

- Options: Markdown-native: each visual is plain markdown the renderer styles (callouts as labeled blockquotes, matrix as a table, pills as bracket tokens). You can comment on a specific risk/file/row; line-budgets + diff keep working; degrades to readable markdown if rendering ever fails (recommended) | Fenced mini-DSLs: new fenced block languages the renderer parses. Cleaner, more explicit authoring, but comments anchor only at the section level, and the blocks sit outside the budget/diff machinery (like code fences today) | Mixed: markdown-native for callouts, matrix, and pills; a fenced block only for the file tree (awkward to express as a plain markdown list)
- Answer: not include file-tree right now so we can rely on the markdown-native without any downside

### q4 — Visual treatment for callouts (and pills): how far from the 'mono + one accent hue' codec discipline (DESIGN.md section 10) should the TYPE be encoded? I recommend semantic ink — it reuses the section-10 accent-mark vocabulary (2px top rule + glyph), just letting the hue vary by type, so risks visibly pop without becoming Notion blocks.

- Options: Semantic ink, no fills: flat panel with a 2px top rule + a glyph, where the HUE encodes type (risk=amber/red, note=accent/blue, decision=accent, assumption=muted gray). No background fills, no rounded corners. Pops out of prose, stays in the codec look (recommended) | Strict mono + accent only: type shown by label + glyph + hairline weight in the existing ink/accent palette, zero new hues. Maximum section-10 fidelity, but pops less | Semantic hues + faint tinted panel: same hues plus a very faint background wash behind the panel. Most scannable, furthest from the flat-panel discipline
- Answer: Semantic ink, no fills: flat panel with a 2px top rule + a glyph, where the HUE encodes type (risk=amber/red, note=accent/blue, decision=accent, assumption=muted gray). No background fills, no rounded corners. Pops out of prose, stays in the codec look

### q5 — These visuals are markdown (blockquotes/tables), so by default they'd count toward the tight line budgets (a Risk entry is <=2 lines, a Goal <=3). How should they count, so the 'no wall of text' invariant survives without blocking their use?

- Options: Budget-exempt but count-capped: callouts/matrices don't count toward line budgets (so a 2-line Risk can BE a callout), but a section gets at most N of them (like today's 1-fence cap) so it can't become a wall of widgets. Pills are always free (inline). Cap is tunable config (recommended) | Count every line as today: no special rule, callouts/matrices count toward the section's line budget. Simplest, but tight sections effectively can't hold one | No new limits: visuals unlimited everywhere. Most expressive, drops the anti-wall-of-text guardrail
- Answer: Budget-exempt but count-capped: callouts/matrices don't count toward line budgets (so a 2-line Risk can BE a callout), but a section gets at most N of them (like today's 1-fence cap) so it can't become a wall of widgets. Pills are always free (inline). Cap is tunable config

### q6 — How hard should the wrapper prompt push the agent to actually USE these visuals instead of reverting to prose?

- Options: Strong guidance + soft SHOULD suggestions: a Visuals section in the wrapper with examples and rules like 'prefer a callout/matrix over prose where it carries the info; a Decisions section weighing 2+ options SHOULD use a matrix; risks/assumptions SHOULD be callouts.' No lint enforcement, which avoids cargo-culted decoration (recommended) | Add a lint warning too: a deterministic WARNING when a plan has zero visuals (or a multi-option Decisions section with no matrix). Pushes adoption hardest, but risks decorative visuals added just to silence it | Light mention only: one wrapper line listing the primitives, no prescriptions. Lowest over-use risk, slowest adoption
- Answer: Strong guidance + soft SHOULD suggestions: a Visuals section in the wrapper with examples and rules like 'prefer a callout/matrix over prose where it carries the info; a Decisions section weighing 2+ options SHOULD use a matrix; risks/assumptions SHOULD be callouts.' No lint enforcement, which avoids cargo-culted decoration

### q7 — Final sizing. v1 is 3 markdown-native primitives (Callouts, Decision matrix, Inline pills) + the count-cap budget rule + the wrapper-prompt push. Given the repo's ~300 LOC/commit discipline, how should it land?

- Options: One milestone, phased by primitive: P1 = shared render infra + Callouts as a full vertical slice (parser, CSS, anchoring, budget cap, tests); P2 = Decision matrix; P3 = Inline pills; P4 = wrapper prompt + DESIGN/DECISIONS docs. Each phase a shippable commit (recommended) | Thinner v1: ship Callouts + the wrapper prompt only now (highest-value pop), defer matrix + pills to a fast-follow plan | All in one go: single combined change for all 3 primitives + prompt — fewer commits, but likely well over the LOC guideline
- Answer: One milestone, phased by primitive: P1 = shared render infra + Callouts as a full vertical slice (parser, CSS, anchoring, budget cap, tests); P2 = Decision matrix; P3 = Inline pills; P4 = wrapper prompt + DESIGN/DECISIONS docs. Each phase a shippable commit
