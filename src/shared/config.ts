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
  /** Markdown-native visuals (callouts, decision matrices) per read-path section. */
  maxVisualsPerReadSection: number;
  detailsSoftCapLines: number;
}

export interface OtaconConfig {
  budgets: Budgets;
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
    maxVisualsPerReadSection: 2,
    detailsSoftCapLines: 80,
  },
};

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Overlay one config file's budgets; invalid values are ignored with a notice. */
function mergeBudgets(base: Budgets, raw: unknown, source: string): Budgets {
  if (typeof raw !== "object" || raw === null) return base;
  const budgets = (raw as Record<string, unknown>).budgets;
  if (typeof budgets !== "object" || budgets === null) return base;
  const merged = { ...base };
  for (const key of Object.keys(base) as (keyof Budgets)[]) {
    const value = (budgets as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      merged[key] = value;
    } else if (value !== undefined) {
      process.stderr.write(`otacon: ignoring invalid budgets.${key} in ${source}\n`);
    }
  }
  return merged;
}

/**
 * defaults ← $OTACON_HOME/config.json ← <repo>/otacon.config.json.
 * Loaded fresh on every use so budget tuning takes effect immediately.
 */
export function loadConfig(repoRoot?: string): OtaconConfig {
  let budgets = mergeBudgets(
    DEFAULT_CONFIG.budgets,
    readJsonFile(globalConfigPath()),
    globalConfigPath(),
  );
  if (repoRoot) {
    const repoPath = repoConfigPath(repoRoot);
    budgets = mergeBudgets(budgets, readJsonFile(repoPath), repoPath);
  }
  return { budgets };
}
