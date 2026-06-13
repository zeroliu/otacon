import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "./config.js";
import { otaconHome, otaconPort } from "./paths.js";

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

function writeRepo(config: unknown): void {
  writeFileSync(join(repo, "otacon.config.json"), JSON.stringify(config));
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
