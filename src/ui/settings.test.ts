// Pins the Settings screen's pure helpers (mirrors session-filter.test.ts —
// pure, no DOM, runs under the root tsconfig/bun). The schema fixtures are a
// trimmed stand-in for CONFIG_SCHEMA: the helpers only read section/key/type,
// not the full field set.

import { describe, expect, test } from "bun:test";
import type { ConfigField, ScopeValues } from "../shared/config.js";
import {
  currentValue,
  distinctRepos,
  fieldsBySection,
  inheritedValue,
  isSet,
  overriddenBy,
} from "./settings.js";

const summaryLines: ConfigField = {
  section: "budgets",
  key: "summaryLines",
  label: "Summary lines",
  type: "int",
  default: 5,
  min: 1,
};
const cap: ConfigField = {
  section: "activity",
  key: "cap",
  label: "Activity feed cap",
  type: "int",
  default: 20,
  min: 1,
};
const desktop: ConfigField = {
  section: "notifications",
  key: "desktop",
  label: "Desktop notifications",
  type: "bool",
  default: true,
};
const worktreeDir: ConfigField = {
  section: "worktree",
  key: "dir",
  label: "Worktree directory",
  type: "path",
  default: ".otacon/worktrees",
};

describe("distinctRepos", () => {
  test("dedupes and stable-sorts repo paths", () => {
    const repos = distinctRepos([
      { repo: "/home/b" },
      { repo: "/home/a" },
      { repo: "/home/b" },
      { repo: "/home/c" },
    ]);
    expect(repos).toEqual(["/home/a", "/home/b", "/home/c"]);
  });

  test("drops blank repos and yields [] for none", () => {
    expect(distinctRepos([{ repo: "" }, { repo: "" }])).toEqual([]);
    expect(distinctRepos([])).toEqual([]);
  });
});

describe("fieldsBySection", () => {
  test("groups in fixed section order, omitting empty sections", () => {
    // Intentionally out of order + missing the worktree section.
    const groups = fieldsBySection([cap, summaryLines, desktop]);
    // worktree leads the order but is absent here, so notifications comes first.
    expect(groups.map((g) => g.section)).toEqual(["notifications", "budgets", "activity"]);
    expect(groups[0]?.fields).toEqual([desktop]);
    expect(groups[1]?.fields).toEqual([summaryLines]);
    expect(groups[2]?.fields).toEqual([cap]);
  });

  test("orders worktree first and notifications second", () => {
    const groups = fieldsBySection([summaryLines, cap, desktop, worktreeDir]);
    expect(groups.map((g) => g.section)).toEqual([
      "worktree",
      "notifications",
      "budgets",
      "activity",
    ]);
  });

  test("preserves field order within a section", () => {
    const second: ConfigField = { ...summaryLines, key: "contractLines", label: "Contract" };
    const groups = fieldsBySection([summaryLines, second]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.fields.map((f) => f.key)).toEqual(["summaryLines", "contractLines"]);
  });

  test("empty schema yields no groups", () => {
    expect(fieldsBySection([])).toEqual([]);
  });
});

describe("currentValue / isSet", () => {
  const values: ScopeValues = { budgets: { summaryLines: 8 }, notifications: { desktop: false } };

  test("reads a set value across types", () => {
    expect(currentValue(values, summaryLines)).toBe(8);
    expect(currentValue(values, desktop)).toBe(false);
    expect(isSet(values, summaryLines)).toBe(true);
    expect(isSet(values, desktop)).toBe(true);
  });

  test("reports unset for a field the scope omits", () => {
    expect(currentValue(values, cap)).toBeUndefined();
    expect(isSet(values, cap)).toBe(false);
    // section present but key absent
    expect(isSet(values, worktreeDir)).toBe(false);
  });

  test("tolerates an undefined/empty scope", () => {
    expect(currentValue(undefined, summaryLines)).toBeUndefined();
    expect(isSet(undefined, summaryLines)).toBe(false);
    expect(isSet({}, summaryLines)).toBe(false);
  });

  test("a set false/0 value still counts as set (not mistaken for unset)", () => {
    const explicit: ScopeValues = {
      notifications: { desktop: false },
      budgets: { summaryLines: 0 },
    };
    expect(isSet(explicit, desktop)).toBe(true);
    expect(currentValue(explicit, desktop)).toBe(false);
    expect(isSet(explicit, summaryLines)).toBe(true);
    expect(currentValue(explicit, summaryLines)).toBe(0);
  });
});

describe("inheritedValue", () => {
  const userValues: ScopeValues = { budgets: { summaryLines: 8 }, notifications: { desktop: false } };
  const projectValues: ScopeValues = { budgets: { summaryLines: 9 } };

  test("User scope (no parents) always falls back to the schema default", () => {
    expect(inheritedValue(summaryLines, [])).toEqual({ value: 5, from: "default" });
    expect(inheritedValue(desktop, [])).toEqual({ value: true, from: "default" });
  });

  test("Project scope inherits the user profile's value, else the schema default", () => {
    const parents = [{ from: "user" as const, values: userValues }];
    expect(inheritedValue(summaryLines, parents)).toEqual({ value: 8, from: "user" });
    // A parent override of `false` is still the inherited value, not "unset".
    expect(inheritedValue(desktop, parents)).toEqual({ value: false, from: "user" });
    // cap is set by neither → the schema default.
    expect(inheritedValue(cap, parents)).toEqual({ value: 20, from: "default" });
  });

  test("Project·local inherits project first, then user, then the schema default", () => {
    const parents = [
      { from: "project" as const, values: projectValues },
      { from: "user" as const, values: userValues },
    ];
    // project sets summaryLines=9 → it wins over the user's 8.
    expect(inheritedValue(summaryLines, parents)).toEqual({ value: 9, from: "project" });
    // desktop is set only by user → falls through project to user's false.
    expect(inheritedValue(desktop, parents)).toEqual({ value: false, from: "user" });
    // cap is set by no parent → the schema default.
    expect(inheritedValue(cap, parents)).toEqual({ value: 20, from: "default" });
  });

  test("tolerates undefined/empty parent values in the chain", () => {
    const parents = [
      { from: "project" as const, values: undefined },
      { from: "user" as const, values: {} },
    ];
    expect(inheritedValue(summaryLines, parents)).toEqual({ value: 5, from: "default" });
  });
});

describe("overriddenBy", () => {
  const projectValues: ScopeValues = { budgets: { summaryLines: 9 } };
  const localValues: ScopeValues = { notifications: { desktop: true } };

  test("returns the highest-precedence scope above that sets the field", () => {
    const overriders = [
      { by: "project.local" as const, values: localValues },
      { by: "project" as const, values: projectValues },
    ];
    // project·local sets desktop → it's the override even if project also did.
    expect(overriddenBy(desktop, overriders)).toBe("project.local");
    // only project sets summaryLines → project is the override.
    expect(overriddenBy(summaryLines, overriders)).toBe("project");
    // nobody above sets cap.
    expect(overriddenBy(cap, overriders)).toBeNull();
  });

  test("project·local outranks project when both set the same field", () => {
    const overriders = [
      { by: "project.local" as const, values: { budgets: { summaryLines: 11 } } },
      { by: "project" as const, values: projectValues },
    ];
    expect(overriddenBy(summaryLines, overriders)).toBe("project.local");
  });

  test("an empty overrider list (project·local, the top layer) never flags", () => {
    expect(overriddenBy(summaryLines, [])).toBeNull();
  });
});
