import { parsePlan } from "./parse.js";
import { checkFrontmatterAuthority, checkL1, checkL2, checkL3, checkL5, checkL6, } from "./rules.js";
export function lint(content, config, options = {}) {
    const plan = parsePlan(content);
    const issues = [
        ...plan.parseErrors,
        ...checkL1(plan, options.session),
        ...checkL2(plan, config.budgets),
        ...(options.grill ? checkL3(plan, options.grill) : []),
        ...(options.resolutions ? checkL5(options.resolutions) : []),
        ...checkL6(plan, config.budgets),
        ...checkFrontmatterAuthority(plan, options),
    ];
    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");
    return { ok: errors.length === 0, errors, warnings };
}
//# sourceMappingURL=index.js.map