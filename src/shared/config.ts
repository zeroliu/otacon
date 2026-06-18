import { readFileSync } from "node:fs";
import { globalConfigPath, repoConfigPath, repoLocalConfigPath } from "./paths.js";

export interface Budgets {
  summaryLines: number;
  /** Read-path line budget for the optional `## Contract` section (DESIGN.md §4). */
  contractLines: number;
  /** Read-path line budget for the optional `## Impact` (blast-radius) section (DESIGN.md §4). */
  impactLines: number;
  decisionEntryLines: number;
  phaseGoalLines: number;
  phaseVerificationLines: number;
  /** Max Given/When/Then scenarios in one phase's ```gwt block (DESIGN.md §4). */
  gwtMaxScenarios: number;
  risksMaxItems: number;
  riskEntryLines: number;
  maxFencesPerReadSection: number;
  /** Markdown-native visuals (callouts, decision matrices) per read-path section. */
  maxVisualsPerReadSection: number;
  detailsSoftCapLines: number;
}

/**
 * Live-activity tuning (DESIGN.md §6, §15): `cap` is how many newest progress
 * notes the feed keeps and shows; `noteMaxChars` trims an over-long note
 * server-side so narration never fails or bloats payloads. Both are first-week
 * tuning guesses (§15). The UI's live/offline threshold is a sibling tunable
 * but lives as a UI constant — the SPA reads no config file.
 */
export interface ActivityConfig {
  cap: number;
  noteMaxChars: number;
}

/** Attention notifications (DESIGN.md §6). Desktop = a native macOS banner. */
export interface Notifications {
  desktop: boolean;
}

/**
 * Where Approve & Implement builds open their git worktrees. Consumed by the
 * agent implement loop. Defaults to `~/.otacon/worktrees` (a `~`/absolute path
 * outside the repo) so throwaway build trees never land in the project; a
 * repo-relative path still works if you'd rather keep them under the repo.
 */
export interface WorktreeConfig {
  dir: string;
}

/**
 * Where **Save** writes the approved plan's project copy (DESIGN.md §12). A
 * repo-relative path; the default `.otacon/plans` keeps the copy beside otacon's
 * other working state, set it to e.g. `docs/plans` to group it with other tracked
 * plans. The canonical copy always lands in the home store
 * (`~/.otacon/sessions/<id>/`); this only governs the in-project copy.
 */
export interface PlansConfig {
  dir: string;
}

/**
 * Auto-update at `otacon start` (DESIGN.md §16). When `auto` is true (default),
 * a pre-session gate fetches the latest published version and self-updates;
 * set it false to pin the installed version (CI, air-gapped, pinned-version
 * shops). Only `otacon start` ever runs the check; the 1h throttle and the
 * registry fetch are fail-open.
 */
export interface UpdateConfig {
  auto: boolean;
}

export interface OtaconConfig {
  budgets: Budgets;
  activity: ActivityConfig;
  notifications: Notifications;
  worktree: WorktreeConfig;
  plans: PlansConfig;
  update: UpdateConfig;
}

export const DEFAULT_CONFIG: OtaconConfig = {
  budgets: {
    summaryLines: 5,
    contractLines: 12,
    impactLines: 10,
    decisionEntryLines: 3,
    phaseGoalLines: 3,
    phaseVerificationLines: 3,
    gwtMaxScenarios: 6,
    risksMaxItems: 5,
    riskEntryLines: 2,
    maxFencesPerReadSection: 1,
    maxVisualsPerReadSection: 2,
    detailsSoftCapLines: 80,
  },
  activity: {
    cap: 20,
    noteMaxChars: 200,
  },
  notifications: { desktop: true },
  worktree: { dir: "~/.otacon/worktrees" },
  plans: { dir: ".otacon/plans" },
  update: { auto: true },
};

export type ConfigFieldType = "int" | "bool" | "path";

/**
 * Field metadata for one leaf config key — the single source of truth shared by
 * runtime merging (loadConfig) and the config API/Settings UI. `label` and
 * `description` are human strings the UI renders; `type` drives validation.
 */
export interface ConfigField {
  section: keyof OtaconConfig;
  key: string;
  label: string;
  description?: string;
  type: ConfigFieldType;
  default: number | boolean | string;
  min?: number;
}

/**
 * One entry per leaf config key. The guard test asserts this enumerates exactly
 * the leaves of DEFAULT_CONFIG, so config can never grow without a schema entry.
 */
export const CONFIG_SCHEMA: ConfigField[] = [
  // budgets — read-path line caps (DESIGN.md §4, §5)
  {
    section: "budgets",
    key: "summaryLines",
    label: "Summary lines",
    description: "Max lines in a plan's summary block.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.summaryLines,
    min: 1,
  },
  {
    section: "budgets",
    key: "contractLines",
    label: "Contract lines",
    description: "Max lines in the optional ## Contract section.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.contractLines,
    min: 1,
  },
  {
    section: "budgets",
    key: "impactLines",
    label: "Impact lines",
    description: "Max lines in the optional ## Impact (blast-radius) section.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.impactLines,
    min: 1,
  },
  {
    section: "budgets",
    key: "decisionEntryLines",
    label: "Decision entry lines",
    description: "Max lines per decision-record entry.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.decisionEntryLines,
    min: 1,
  },
  {
    section: "budgets",
    key: "phaseGoalLines",
    label: "Phase goal lines",
    description: "Max lines in a phase's goal block.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.phaseGoalLines,
    min: 1,
  },
  {
    section: "budgets",
    key: "phaseVerificationLines",
    label: "Phase verification lines",
    description: "Max lines in a phase's verification block.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.phaseVerificationLines,
    min: 1,
  },
  {
    section: "budgets",
    key: "gwtMaxScenarios",
    label: "Max GWT scenarios",
    description: "Max Given/When/Then scenarios in one phase's gwt block.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.gwtMaxScenarios,
    min: 1,
  },
  {
    section: "budgets",
    key: "risksMaxItems",
    label: "Max risk items",
    description: "Max entries in the risks list.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.risksMaxItems,
    min: 1,
  },
  {
    section: "budgets",
    key: "riskEntryLines",
    label: "Risk entry lines",
    description: "Max lines per risk entry.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.riskEntryLines,
    min: 1,
  },
  {
    section: "budgets",
    key: "maxFencesPerReadSection",
    label: "Max fences per section",
    description: "Max fenced blocks in one read-path section.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.maxFencesPerReadSection,
    min: 1,
  },
  {
    section: "budgets",
    key: "maxVisualsPerReadSection",
    label: "Max visuals per section",
    description: "Max markdown-native visuals (callouts, matrices) per read-path section.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.maxVisualsPerReadSection,
    min: 1,
  },
  {
    section: "budgets",
    key: "detailsSoftCapLines",
    label: "Details soft cap",
    description: "Soft cap on raw lines inside a details block.",
    type: "int",
    default: DEFAULT_CONFIG.budgets.detailsSoftCapLines,
    min: 1,
  },
  // activity — live feed tuning (DESIGN.md §6, §15)
  {
    section: "activity",
    key: "cap",
    label: "Activity feed cap",
    description: "How many newest progress notes the feed keeps.",
    type: "int",
    default: DEFAULT_CONFIG.activity.cap,
    min: 1,
  },
  {
    section: "activity",
    key: "noteMaxChars",
    label: "Note max characters",
    description: "Server-side trim length for an over-long progress note.",
    type: "int",
    default: DEFAULT_CONFIG.activity.noteMaxChars,
    min: 1,
  },
  // notifications — attention banners (DESIGN.md §6)
  {
    section: "notifications",
    key: "desktop",
    label: "Desktop notifications",
    description: "Native macOS banner when a session needs your attention.",
    type: "bool",
    default: DEFAULT_CONFIG.notifications.desktop,
  },
  // worktree — Approve & Implement build location (DESIGN.md §12)
  {
    section: "worktree",
    key: "dir",
    label: "Worktree directory",
    description: "Base dir for Approve & Implement build worktrees (default ~/.otacon/worktrees, outside the repo).",
    type: "path",
    default: DEFAULT_CONFIG.worktree.dir,
  },
  // plans — where Save writes the approved plan's project copy (DESIGN.md §12)
  {
    section: "plans",
    key: "dir",
    label: "Plans directory",
    description: "Where Save writes the approved plan copy in the project (repo-relative).",
    type: "path",
    default: DEFAULT_CONFIG.plans.dir,
  },
  // update — auto-update at otacon start (DESIGN.md §16)
  {
    section: "update",
    key: "auto",
    label: "Auto-update on start",
    description: "Self-update to the latest published version at otacon start (off pins the installed version).",
    type: "bool",
    default: DEFAULT_CONFIG.update.auto,
  },
];

type CoerceResult = { ok: true; value: number | boolean | string } | { ok: false };

/**
 * Validate one raw value against a field's type rule, shared by loadConfig's
 * overlay and the config API validator:
 *   int  → finite number, > 0 (and >= field.min if set)
 *   bool → boolean
 *   path → non-empty string (trimmed)
 */
export function coerceFieldValue(field: ConfigField, raw: unknown): CoerceResult {
  switch (field.type) {
    case "int": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return { ok: false };
      if (raw <= 0) return { ok: false };
      if (field.min !== undefined && raw < field.min) return { ok: false };
      return { ok: true, value: raw };
    }
    case "bool": {
      if (typeof raw !== "boolean") return { ok: false };
      return { ok: true, value: raw };
    }
    case "path": {
      if (typeof raw !== "string") return { ok: false };
      const trimmed = raw.trim();
      if (trimmed.length === 0) return { ok: false };
      return { ok: true, value: trimmed };
    }
  }
}

const SCHEMA_BY_SECTION = new Map<string, ConfigField[]>();
for (const field of CONFIG_SCHEMA) {
  const list = SCHEMA_BY_SECTION.get(field.section) ?? [];
  list.push(field);
  SCHEMA_BY_SECTION.set(field.section, list);
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Walk every schema field that `raw` provides (a nested `{ section: { key } }`
 * object), coercing each against its type rule. `onResult` fires once per
 * provided known key with the field, its section, and the coercion result —
 * the single iteration shared by the file overlay, the API validator, and the
 * scope reader. A non-object `raw` (or section) is treated as "provides
 * nothing".
 */
function walkProvidedFields(
  raw: unknown,
  onResult: (section: string, field: ConfigField, result: CoerceResult) => void,
): void {
  if (typeof raw !== "object" || raw === null) return;
  const root = raw as Record<string, unknown>;
  for (const [section, fields] of SCHEMA_BY_SECTION) {
    const obj = root[section];
    if (typeof obj !== "object" || obj === null) continue;
    const sectionObj = obj as Record<string, unknown>;
    for (const field of fields) {
      if (!(field.key in sectionObj)) continue;
      onResult(section, field, coerceFieldValue(field, sectionObj[field.key]));
    }
  }
}

/**
 * Overlay one config file onto `base`, schema-driven: for every known field,
 * a provided value that passes `coerceFieldValue` wins; an invalid provided
 * value is ignored with a notice (same wording/behavior as before). Unknown
 * keys are silently ignored.
 */
function overlayConfig(base: OtaconConfig, raw: unknown, source: string): OtaconConfig {
  const merged: OtaconConfig = {
    budgets: { ...base.budgets },
    activity: { ...base.activity },
    notifications: { ...base.notifications },
    worktree: { ...base.worktree },
    plans: { ...base.plans },
    update: { ...base.update },
  };
  const mergedSections = merged as unknown as Record<string, Record<string, unknown>>;
  walkProvidedFields(raw, (section, field, result) => {
    if (result.ok) {
      // section always names a key of OtaconConfig (it came from CONFIG_SCHEMA),
      // so the merged section object is always present.
      (mergedSections[section] as Record<string, unknown>)[field.key] = result.value;
    } else {
      process.stderr.write(
        `otacon: ignoring invalid ${section}.${field.key} in ${source}\n`,
      );
    }
  });
  return merged;
}

/**
 * defaults ← user (`$OTACON_HOME/config.json`) ← project
 * (`<repo>/.otacon/config.json`, team-shared) ← project.local
 * (`<repo>/.otacon/config.local.json`, personal). Closest wins. Loaded fresh
 * on every use so tuning takes effect immediately. Each file is overlaid field
 * by field against CONFIG_SCHEMA (budgets, activity, notifications, worktree,
 * plans, update).
 */
export function loadConfig(repoRoot?: string): OtaconConfig {
  const overlay = (source: string, into: OtaconConfig): OtaconConfig =>
    overlayConfig(into, readJsonFile(source), source);
  let config = overlay(globalConfigPath(), DEFAULT_CONFIG);
  if (repoRoot) {
    config = overlay(repoConfigPath(repoRoot), config);
    config = overlay(repoLocalConfigPath(repoRoot), config);
  }
  return config;
}

/** A nested sparse partial: `{ section: { key: value } }` for known keys only. */
export type ScopeValues = {
  [S in keyof OtaconConfig]?: Partial<OtaconConfig[S]>;
};

/**
 * Read+parse a scope JSON file and return ONLY schema-known keys whose values
 * pass `coerceFieldValue` (sparse; missing/garbage file → `{}`). This is what
 * GET shows as a scope's current values.
 */
export function readScopeValues(path: string): ScopeValues {
  const out: Record<string, Record<string, unknown>> = {};
  walkProvidedFields(readJsonFile(path), (section, field, result) => {
    if (result.ok) (out[section] ??= {})[field.key] = result.value;
  });
  return out as ScopeValues;
}

/** A single field-level validation failure from `validateScopeInput`. */
export interface ScopeFieldError {
  section: string;
  key: string;
  message: string;
}

/**
 * Validate a nested `{ section: { key: value } }` partial against the schema:
 * unknown sections/keys are ignored, each known provided key is coerced; on
 * failure a field error is recorded. Returns the sanitized sparse `values`
 * (only valid, provided keys). This is what POST validates + persists.
 */
export function validateScopeInput(input: unknown): {
  values: ScopeValues;
  errors: ScopeFieldError[];
} {
  const values: Record<string, Record<string, unknown>> = {};
  const errors: ScopeFieldError[] = [];
  walkProvidedFields(input, (section, field, result) => {
    if (result.ok) {
      (values[section] ??= {})[field.key] = result.value;
    } else {
      errors.push({
        section,
        key: field.key,
        message: `invalid value for ${section}.${field.key}`,
      });
    }
  });
  return { values: values as ScopeValues, errors };
}
