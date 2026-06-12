import type { OtaconConfig } from "../../shared/config.js";
import type { LintResult } from "../../shared/types.js";
import { parsePlan } from "./parse.js";
import {
  checkFrontmatterAuthority,
  checkL1,
  checkL2,
  checkL5,
  checkL6,
  type FrontmatterExpectations,
  type ResolutionContext,
} from "./rules.js";

export type { ResolutionContext } from "./rules.js";

export interface LintOptions extends FrontmatterExpectations {
  /** Target session id; mismatching frontmatter.session is a hard error. */
  session?: string;
  /** L5 context, composed by the daemon (the linter itself never reads state). */
  resolutions?: ResolutionContext;
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
    ...(options.resolutions ? checkL5(options.resolutions) : []),
    ...checkL6(plan, config.budgets),
    ...checkFrontmatterAuthority(plan, options),
  ];
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return { ok: errors.length === 0, errors, warnings };
}
