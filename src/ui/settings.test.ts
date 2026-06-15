// Pins the Settings screen's pure helpers (mirrors session-filter.test.ts —
// pure, no DOM, runs under the root tsconfig/bun). The schema fixtures are a
// trimmed stand-in for CONFIG_SCHEMA: the helpers only read section/key/type,
// not the full field set.

import { describe, expect, test } from "bun:test";
import type { ConfigField, ScopeValues } from "../shared/config.js";
import { currentValue, distinctRepos, fieldsBySection, isSet } from "./settings.js";

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
    expect(groups.map((g) => g.section)).toEqual(["budgets", "activity", "notifications"]);
    expect(groups[0]?.fields).toEqual([summaryLines]);
    expect(groups[1]?.fields).toEqual([cap]);
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
