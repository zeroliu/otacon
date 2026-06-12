import type { OtaconConfig } from "../../shared/config.js";
import type { LintResult } from "../../shared/types.js";
import { parsePlan } from "./parse.js";
import {
  checkFrontmatterAuthority,
  checkL1,
  checkL2,
  checkL6,
  type FrontmatterExpectations,
} from "./rules.js";

export interface LintOptions extends FrontmatterExpectations {
  /** Target session id; mismatching frontmatter.session is a hard error. */
  session?: string;
}

export function lint(
  content: string,
  config: OtaconConfig,
  options: LintOptions = {},
): LintResult {
  const plan = parsePlan(content);
  const issues = [
    ...plan.parseErrors,
    ...checkL1(plan, options.session),
    ...checkL2(plan, config.budgets),
    ...checkL6(plan, config.budgets),
    ...checkFrontmatterAuthority(plan, options),
  ];
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { ok: errors.length === 0, errors, warnings };
}
