// Pure helpers the Settings screen renders from (DESIGN.md §6 config surface),
// kept React-free + co-located-tested like session-filter.ts: the screen wires
// these to the DOM, the unit tests pin the logic. `ConfigField` and the sparse
// `ScopeValues` shape come from the shared config module — the same schema the
// daemon's GET /api/config serves.

import type { ConfigField, OtaconConfig, ScopeValues } from "../shared/config.js";

/**
 * Section render order for the Settings screen. Worktree leads (it's the field
 * an Approve & Implement build reads first), notifications second; the line
 * budgets follow as the long tail. Independent of CONFIG_SCHEMA's own order.
 */
const SECTION_ORDER: Array<keyof OtaconConfig> = [
  "worktree",
  "notifications",
  "budgets",
  "activity",
];

/**
 * Unique repo paths across the open sessions, stable-sorted, for the Project
 * scope's repo `<select>`. Accepts any session shape carrying a `repo` string
 * (the live session list or a plain array), so the screen can pass
 * `useSessions().sessions` straight through. Blank repos are dropped.
 */
export function distinctRepos(sessions: Iterable<{ repo: string }>): string[] {
  const seen = new Set<string>();
  for (const { repo } of sessions) {
    if (repo !== "") seen.add(repo);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** One section's heading plus its fields, in schema order. */
export interface SectionFields {
  section: keyof OtaconConfig;
  fields: ConfigField[];
}

/**
 * Group the flat schema into sections in the fixed SECTION_ORDER, preserving
 * each field's order within its section. A section with no fields is omitted,
 * and any field whose section is outside the known order is dropped (it could
 * not render under a heading) — the schema guard test keeps that set empty.
 */
export function fieldsBySection(schema: ConfigField[]): SectionFields[] {
  return SECTION_ORDER.map((section) => ({
    section,
    fields: schema.filter((field) => field.section === section),
  })).filter((group) => group.fields.length > 0);
}

/**
 * The value this field is set to in a scope's sparse `values`, or `undefined`
 * when the scope does not override it (so the screen shows the schema default
 * as a placeholder). Tolerates a missing/partial section object.
 */
export function currentValue(
  values: ScopeValues | undefined,
  field: ConfigField,
): number | boolean | string | undefined {
  const section = values?.[field.section] as Record<string, unknown> | undefined;
  const value = section?.[field.key];
  return value as number | boolean | string | undefined;
}

/** Whether this scope explicitly overrides the field (vs inheriting the default). */
export function isSet(values: ScopeValues | undefined, field: ConfigField): boolean {
  const section = values?.[field.section] as Record<string, unknown> | undefined;
  return section !== undefined && field.key in section;
}

/** Where an inherited fallback comes from, mirroring the overlay order. */
export type InheritedFrom = "project" | "user" | "default";

/**
 * One ancestor scope in the inheritance chain: its label (the source the hint
 * names) and its sparse values. The chain is passed highest-precedence-first
 * (so `project` before `user`), mirroring the file overlay defaults ← user ←
 * project ← project.local (DESIGN.md §16): the first ancestor that overrides the
 * field wins, and reports itself as the source.
 */
export interface ParentScope {
  from: "project" | "user";
  values: ScopeValues | undefined;
}

/**
 * The value a field falls back to when the active scope doesn't override it,
 * plus where that fallback comes from. `parents` is the inheritance chain the
 * active scope sits atop, highest-precedence first:
 *   - User scope    → `[]` (no parent; always the schema default).
 *   - Project scope → `[user]` (user override, else the schema default).
 *   - Project·local → `[project, user]` (project override, else user override,
 *     else the schema default).
 * The first ancestor that sets the field wins and names itself as `from`;
 * otherwise the schema default applies.
 */
export interface InheritedValue {
  value: number | boolean | string;
  from: InheritedFrom;
}

export function inheritedValue(field: ConfigField, parents: ParentScope[]): InheritedValue {
  for (const parent of parents) {
    const value = currentValue(parent.values, field);
    if (value !== undefined) return { value, from: parent.from };
  }
  return { value: field.default, from: "default" };
}

/** A higher-precedence scope that shadows the active one's value for a field. */
export interface OverrideScope {
  by: "project" | "project.local";
  values: ScopeValues | undefined;
}

/**
 * The highest-precedence scope *above* the active one that sets the field —
 * what shadows the active scope's value at resolve time. `overriders` is passed
 * highest-precedence first (project.local before project), so the first one that
 * sets the field is the effective winner the active view flags. Returns `null`
 * when nothing above the active scope overrides the field.
 */
export function overriddenBy(
  field: ConfigField,
  overriders: OverrideScope[],
): "project" | "project.local" | null {
  for (const scope of overriders) {
    if (isSet(scope.values, field)) return scope.by;
  }
  return null;
}
