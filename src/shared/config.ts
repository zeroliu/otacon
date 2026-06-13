import { readFileSync } from "node:fs";
import { globalConfigPath, repoConfigPath } from "./paths.js";

export interface Budgets {
  summaryLines: number;
  decisionEntryLines: number;
  phaseGoalLines: number;
  phaseVerificationLines: number;
  risksMaxItems: number;
  riskEntryLines: number;
  maxFencesPerReadSection: number;
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

export interface OtaconConfig {
  budgets: Budgets;
  activity: ActivityConfig;
}

export const DEFAULT_CONFIG: OtaconConfig = {
  budgets: {
    summaryLines: 5,
    decisionEntryLines: 3,
    phaseGoalLines: 3,
    phaseVerificationLines: 3,
    risksMaxItems: 5,
    riskEntryLines: 2,
    maxFencesPerReadSection: 1,
    detailsSoftCapLines: 80,
  },
  activity: {
    cap: 20,
    noteMaxChars: 200,
  },
};

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Overlay one config file's `<section>` (all positive-number keys); invalid
 * values are ignored with a notice. Both `budgets` and `activity` are flat
 * maps of positive numbers, so they share this merge.
 */
function mergeSection<T extends object>(
  base: T,
  raw: unknown,
  section: string,
  source: string,
): T {
  if (typeof raw !== "object" || raw === null) return base;
  const obj = (raw as Record<string, unknown>)[section];
  if (typeof obj !== "object" || obj === null) return base;
  const merged = { ...base };
  for (const key of Object.keys(base) as (keyof T)[]) {
    const value = (obj as Record<string, unknown>)[key as string];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      merged[key] = value as T[keyof T];
    } else if (value !== undefined) {
      process.stderr.write(`otacon: ignoring invalid ${section}.${String(key)} in ${source}\n`);
    }
  }
  return merged;
}

/**
 * defaults ← $OTACON_HOME/config.json ← <repo>/otacon.config.json.
 * Loaded fresh on every use so tuning takes effect immediately.
 */
export function loadConfig(repoRoot?: string): OtaconConfig {
  const overlay = (source: string, into: OtaconConfig): OtaconConfig => {
    const raw = readJsonFile(source);
    return {
      budgets: mergeSection(into.budgets, raw, "budgets", source),
      activity: mergeSection(into.activity, raw, "activity", source),
    };
  };
  let config = overlay(globalConfigPath(), DEFAULT_CONFIG);
  if (repoRoot) config = overlay(repoConfigPath(repoRoot), config);
  return config;
}
