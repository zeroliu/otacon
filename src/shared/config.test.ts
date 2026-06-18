import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_SCHEMA,
  DEFAULT_CONFIG,
  loadConfig,
  readScopeValues,
  validateScopeInput,
} from "./config.js";
import { otaconHome, otaconPort, repoConfigPath, repoLocalConfigPath } from "./paths.js";

let home: string;
let repo: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.OTACON_HOME = process.env.OTACON_HOME;
  savedEnv.OTACON_PORT = process.env.OTACON_PORT;
  home = mkdtempSync(join(tmpdir(), "otacon-home-"));
  repo = mkdtempSync(join(tmpdir(), "otacon-repo-"));
  process.env.OTACON_HOME = home;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

function writeGlobal(config: unknown): void {
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
}

/** The COMMITTED project config (`<repo>/.otacon/config.json`). */
function writeRepo(config: unknown): void {
  mkdirSync(join(repo, ".otacon"), { recursive: true });
  writeFileSync(repoConfigPath(repo), JSON.stringify(config));
}

/** The personal override (`<repo>/.otacon/config.local.json`). */
function writeProjectLocal(config: unknown): void {
  mkdirSync(join(repo, ".otacon"), { recursive: true });
  writeFileSync(repoLocalConfigPath(repo), JSON.stringify(config));
}

describe("loadConfig", () => {
  test("returns defaults when no config files exist", () => {
    expect(loadConfig(repo)).toEqual(DEFAULT_CONFIG);
  });

  test("global config overrides defaults", () => {
    writeGlobal({ budgets: { summaryLines: 8 } });
    const config = loadConfig(repo);
    expect(config.budgets.summaryLines).toBe(8);
    expect(config.budgets.phaseGoalLines).toBe(3);
  });

  test("repo config overrides global", () => {
    writeGlobal({ budgets: { summaryLines: 8, detailsSoftCapLines: 100 } });
    writeRepo({ budgets: { summaryLines: 10 } });
    const config = loadConfig(repo);
    expect(config.budgets.summaryLines).toBe(10);
    expect(config.budgets.detailsSoftCapLines).toBe(100);
  });

  test("precedence: project.local wins over project, project over user, user over default", () => {
    // All four layers set the SAME key; the closest layer must win.
    writeGlobal({ worktree: { dir: "user/wt" } });
    writeRepo({ worktree: { dir: "project/wt" } });
    writeProjectLocal({ worktree: { dir: "local/wt" } });
    expect(loadConfig(repo).worktree.dir).toBe("local/wt");

    // Drop the closest layer → the next one down wins.
    rmSync(repoLocalConfigPath(repo), { force: true });
    expect(loadConfig(repo).worktree.dir).toBe("project/wt");

    rmSync(repoConfigPath(repo), { force: true });
    expect(loadConfig(repo).worktree.dir).toBe("user/wt");

    rmSync(join(home, "config.json"), { force: true });
    expect(loadConfig(repo).worktree.dir).toBe(DEFAULT_CONFIG.worktree.dir);
  });

  test("project.local overrides only the keys it sets; project and user fill the rest", () => {
    writeGlobal({ budgets: { summaryLines: 8, contractLines: 20 } });
    writeRepo({ budgets: { summaryLines: 9, impactLines: 15 } });
    writeProjectLocal({ budgets: { summaryLines: 10 } });
    const config = loadConfig(repo);
    expect(config.budgets.summaryLines).toBe(10); // project.local
    expect(config.budgets.impactLines).toBe(15); // project
    expect(config.budgets.contractLines).toBe(20); // user
  });

  test("partial merge keeps untouched defaults", () => {
    writeRepo({ budgets: { risksMaxItems: 7 } });
    const config = loadConfig(repo);
    expect(config.budgets.risksMaxItems).toBe(7);
    expect({ ...config.budgets, risksMaxItems: 5 }).toEqual(DEFAULT_CONFIG.budgets);
  });

  test("works without a repoRoot", () => {
    writeGlobal({ budgets: { summaryLines: 6 } });
    expect(loadConfig().budgets.summaryLines).toBe(6);
  });

  test("ignores garbage values", () => {
    writeGlobal({
      budgets: {
        summaryLines: "ten",
        phaseGoalLines: -2,
        riskEntryLines: null,
        detailsSoftCapLines: Infinity,
        unknownKey: 99,
      },
    });
    expect(loadConfig(repo)).toEqual(DEFAULT_CONFIG);
  });

  test("ignores malformed JSON and non-object shapes", () => {
    writeFileSync(join(home, "config.json"), "{not json");
    writeRepo([1, 2, 3]);
    expect(loadConfig(repo)).toEqual(DEFAULT_CONFIG);
  });

  test("config files without a budgets key are ignored", () => {
    writeGlobal({ somethingElse: true });
    expect(loadConfig(repo)).toEqual(DEFAULT_CONFIG);
  });

  test("activity tuning overrides the same way budgets do", () => {
    writeGlobal({ activity: { cap: 50 } });
    writeRepo({ activity: { noteMaxChars: 120 } });
    const config = loadConfig(repo);
    expect(config.activity.cap).toBe(50); // from global
    expect(config.activity.noteMaxChars).toBe(120); // repo overrides
  });

  test("invalid activity values are ignored, keeping defaults", () => {
    writeGlobal({ activity: { cap: 0, noteMaxChars: -5, unknownKey: 3 } });
    expect(loadConfig(repo).activity).toEqual(DEFAULT_CONFIG.activity);
  });
});

describe("loadConfig notifications", () => {
  test("notifications.desktop defaults to true", () => {
    expect(loadConfig(repo).notifications.desktop).toBe(true);
  });

  test("global config can turn desktop notifications off", () => {
    writeGlobal({ notifications: { desktop: false } });
    expect(loadConfig(repo).notifications.desktop).toBe(false);
  });

  test("repo config overrides global for notifications", () => {
    writeGlobal({ notifications: { desktop: false } });
    writeRepo({ notifications: { desktop: true } });
    expect(loadConfig(repo).notifications.desktop).toBe(true);
  });

  test("a non-boolean desktop value is ignored, keeping the default", () => {
    writeGlobal({ notifications: { desktop: "yes" } });
    expect(loadConfig(repo).notifications.desktop).toBe(true);
  });

  test("budgets and notifications merge independently from one file", () => {
    writeGlobal({ budgets: { summaryLines: 9 }, notifications: { desktop: false } });
    const config = loadConfig(repo);
    expect(config.budgets.summaryLines).toBe(9);
    expect(config.notifications.desktop).toBe(false);
  });
});

describe("loadConfig worktree", () => {
  test("worktree.dir defaults to ~/.otacon/worktrees", () => {
    expect(loadConfig(repo).worktree.dir).toBe("~/.otacon/worktrees");
  });

  test("global config can override worktree.dir", () => {
    writeGlobal({ worktree: { dir: "build/wt" } });
    expect(loadConfig(repo).worktree.dir).toBe("build/wt");
  });

  test("repo config overrides global for worktree.dir", () => {
    writeGlobal({ worktree: { dir: "build/wt" } });
    writeRepo({ worktree: { dir: ".otacon/builds" } });
    expect(loadConfig(repo).worktree.dir).toBe(".otacon/builds");
  });

  test("an empty or non-string worktree.dir is ignored, keeping the default", () => {
    writeGlobal({ worktree: { dir: "   " } });
    expect(loadConfig(repo).worktree.dir).toBe("~/.otacon/worktrees");
    writeGlobal({ worktree: { dir: 5 } });
    expect(loadConfig(repo).worktree.dir).toBe("~/.otacon/worktrees");
  });

  test("worktree.dir is trimmed", () => {
    writeGlobal({ worktree: { dir: "  build/wt  " } });
    expect(loadConfig(repo).worktree.dir).toBe("build/wt");
  });
});

describe("loadConfig plans", () => {
  test("plans.dir defaults to .otacon/plans", () => {
    expect(loadConfig(repo).plans.dir).toBe(".otacon/plans");
  });

  test("global config can override plans.dir", () => {
    writeGlobal({ plans: { dir: "docs/plans" } });
    expect(loadConfig(repo).plans.dir).toBe("docs/plans");
  });

  test("project < project.local precedence holds for plans.dir", () => {
    writeGlobal({ plans: { dir: "user/plans" } });
    writeRepo({ plans: { dir: "docs/plans" } });
    writeProjectLocal({ plans: { dir: ".otacon/plans" } });
    expect(loadConfig(repo).plans.dir).toBe(".otacon/plans");
  });

  test("an empty or non-string plans.dir is ignored, keeping the default", () => {
    writeGlobal({ plans: { dir: "   " } });
    expect(loadConfig(repo).plans.dir).toBe(".otacon/plans");
    writeGlobal({ plans: { dir: 5 } });
    expect(loadConfig(repo).plans.dir).toBe(".otacon/plans");
  });
});

describe("loadConfig update", () => {
  test("update.auto defaults to true", () => {
    expect(loadConfig(repo).update.auto).toBe(true);
  });

  test("global config can turn auto-update off", () => {
    writeGlobal({ update: { auto: false } });
    expect(loadConfig(repo).update.auto).toBe(false);
  });

  test("repo config overrides global for update.auto", () => {
    writeGlobal({ update: { auto: false } });
    writeRepo({ update: { auto: true } });
    expect(loadConfig(repo).update.auto).toBe(true);
  });

  test("a non-boolean auto value is ignored, keeping the default", () => {
    writeGlobal({ update: { auto: "yes" } });
    expect(loadConfig(repo).update.auto).toBe(true);
  });
});

describe("CONFIG_SCHEMA guard", () => {
  test("enumerates exactly the leaf keys of DEFAULT_CONFIG", () => {
    const schemaLeaves = new Set(CONFIG_SCHEMA.map((f) => `${f.section}.${f.key}`));
    const configLeaves = new Set<string>();
    for (const [section, obj] of Object.entries(DEFAULT_CONFIG)) {
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        configLeaves.add(`${section}.${key}`);
      }
    }
    expect(schemaLeaves).toEqual(configLeaves);
  });

  test("each field's default matches DEFAULT_CONFIG", () => {
    const sections = DEFAULT_CONFIG as unknown as Record<string, Record<string, unknown>>;
    for (const field of CONFIG_SCHEMA) {
      const value = sections[field.section]?.[field.key];
      expect(field.default).toBe(value as never);
    }
  });
});

describe("validateScopeInput", () => {
  test("accepts valid sparse input and ignores unknown keys", () => {
    const { values, errors } = validateScopeInput({
      budgets: { summaryLines: 8 },
      notifications: { desktop: false },
      worktree: { dir: "build/wt" },
      bogusSection: { x: 1 },
      activity: { unknownKey: 3 },
    });
    expect(errors).toEqual([]);
    expect(values).toEqual({
      budgets: { summaryLines: 8 },
      notifications: { desktop: false },
      worktree: { dir: "build/wt" },
    });
  });

  test("rejects summaryLines=0 with a field error", () => {
    const { values, errors } = validateScopeInput({ budgets: { summaryLines: 0 } });
    expect(values).toEqual({});
    expect(errors).toEqual([
      { section: "budgets", key: "summaryLines", message: expect.any(String) },
    ]);
  });

  test("rejects a non-number int value", () => {
    const { errors } = validateScopeInput({ budgets: { summaryLines: "ten" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ section: "budgets", key: "summaryLines" });
  });

  test("rejects an empty path", () => {
    const { errors } = validateScopeInput({ worktree: { dir: "   " } });
    expect(errors).toEqual([
      { section: "worktree", key: "dir", message: expect.any(String) },
    ]);
  });

  test("non-object input yields no values and no errors", () => {
    expect(validateScopeInput(null)).toEqual({ values: {}, errors: [] });
    expect(validateScopeInput(42)).toEqual({ values: {}, errors: [] });
  });
});

describe("readScopeValues", () => {
  test("returns sparse known-good values and ignores junk", () => {
    const path = join(home, "scope.json");
    writeFileSync(
      path,
      JSON.stringify({
        budgets: { summaryLines: 9, phaseGoalLines: -1, unknownKey: 1 },
        worktree: { dir: "  build/wt  " },
        bogus: { x: 1 },
      }),
    );
    expect(readScopeValues(path)).toEqual({
      budgets: { summaryLines: 9 },
      worktree: { dir: "build/wt" },
    });
  });

  test("missing file returns {}", () => {
    expect(readScopeValues(join(home, "does-not-exist.json"))).toEqual({});
  });
});

describe("repo config paths", () => {
  test("repoConfigPath is the committed <repo>/.otacon/config.json", () => {
    expect(repoConfigPath(repo)).toBe(join(repo, ".otacon", "config.json"));
  });

  test("repoLocalConfigPath is the personal <repo>/.otacon/config.local.json", () => {
    expect(repoLocalConfigPath(repo)).toBe(join(repo, ".otacon", "config.local.json"));
  });
});

describe("paths env overrides", () => {
  test("otaconHome honors OTACON_HOME", () => {
    expect(otaconHome()).toBe(home);
  });

  test("otaconPort defaults to 4747 and honors valid OTACON_PORT", () => {
    delete process.env.OTACON_PORT;
    expect(otaconPort()).toBe(4747);
    process.env.OTACON_PORT = "4799";
    expect(otaconPort()).toBe(4799);
  });

  test("otaconPort rejects invalid values", () => {
    for (const bad of ["abc", "-1", "0", "70000", "47.5"]) {
      process.env.OTACON_PORT = bad;
      expect(otaconPort()).toBe(4747);
    }
  });
});
