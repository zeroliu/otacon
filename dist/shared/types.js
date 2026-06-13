// Cross-layer types shared by the daemon and the CLI.
// Wire shapes (EventPayload) follow DESIGN.md §6 exactly.
export const SESSION_STATUSES = [
    "draft",
    "in_review",
    "revising",
    "approved",
];
/**
 * The decision-citation grammar: `← q7` or `← q7, q9`; `<-` accepted alongside
 * `←` (models emit both arrows). Global: an entry can carry several citation
 * clauses ("… ← q1; revisit ← q9"). The single source of truth for both lint
 * L3 (src/daemon/linter/rules.ts) and the UI's deep-link transform
 * (ui/src/plan/plan-view.tsx), so they can never disagree about what a
 * citation is. The captured ids MUST stay `q\d+`-only: the UI injects them
 * into markup attributes pre-sanitize and relies on that charset.
 */
export const CITATION_RE = /(?:←|<-)\s*(q\d+(?:\s*,\s*q\d+)*)/g;
//# sourceMappingURL=types.js.map