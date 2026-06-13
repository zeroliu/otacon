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

/** Attention notifications (DESIGN.md §6). Desktop = a native macOS banner. */
export interface Notifications {
  desktop: boolean;
}

export interface OtaconConfig {
  budgets: Budgets;
  notifications: Notifications;
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
  notifications: { desktop: true },
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

/** Overlay one config file's notifications; a non-boolean is ignored with a notice. */
function mergeNotifications(base: Notifications, raw: unknown, source: string): Notifications {
  if (typeof raw !== "object" || raw === null) return base;
  const notifications = (raw as Record<string, unknown>).notifications;
  if (typeof notifications !== "object" || notifications === null) return base;
  const merged = { ...base };
  for (const key of Object.keys(base) as (keyof Notifications)[]) {
    const value = (notifications as Record<string, unknown>)[key];
    if (typeof value === "boolean") {
      merged[key] = value;
    } else if (value !== undefined) {
      process.stderr.write(`otacon: ignoring invalid notifications.${key} in ${source}\n`);
    }
  }
  return merged;
}

/**
 * defaults ← $OTACON_HOME/config.json ← <repo>/otacon.config.json.
 * Loaded fresh on every use so config tuning takes effect immediately. Each
 * file is read once and overlaid section by section (budgets, notifications).
 */
export function loadConfig(repoRoot?: string): OtaconConfig {
  const globalRaw = readJsonFile(globalConfigPath());
  let budgets = mergeBudgets(DEFAULT_CONFIG.budgets, globalRaw, globalConfigPath());
  let notifications = mergeNotifications(DEFAULT_CONFIG.notifications, globalRaw, globalConfigPath());
  if (repoRoot) {
    const repoPath = repoConfigPath(repoRoot);
    const repoRaw = readJsonFile(repoPath);
    budgets = mergeBudgets(budgets, repoRaw, repoPath);
    notifications = mergeNotifications(notifications, repoRaw, repoPath);
  }
  return { budgets, notifications };
}
