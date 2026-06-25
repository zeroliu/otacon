import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
// Cross-module contract pin: the staging string this helper emits is consumed by
// the channel-aware auto-updater, so we assert against its real parsers.
import { channelOf, isNewer } from "../src/cli/update.js";
import { stagingVersion } from "./staging-version.js";

const STAMP = "20260624103000";

describe("stagingVersion — bump semantics", () => {
  test("patch bumps z", () => {
    expect(stagingVersion({ current: "0.1.3", kind: "patch", stamp: STAMP })).toBe(
      "0.1.4-staging.20260624103000",
    );
  });

  test("minor bumps y and zeroes z", () => {
    expect(stagingVersion({ current: "0.1.3", kind: "minor", stamp: STAMP })).toBe(
      "0.2.0-staging.20260624103000",
    );
  });

  test("major bumps x and zeroes y,z", () => {
    expect(stagingVersion({ current: "0.1.3", kind: "major", stamp: STAMP })).toBe(
      "1.0.0-staging.20260624103000",
    );
  });

  test("ignores a leading v on current", () => {
    expect(stagingVersion({ current: "v1.2.3", kind: "patch", stamp: STAMP })).toBe(
      "1.2.4-staging.20260624103000",
    );
  });
});

describe("stagingVersion — strip then bump", () => {
  // A current that already carries a -staging.<old> suffix is stripped to its
  // clean core FIRST, then bumped — so repeated staging cuts never inflate the
  // base. "0.1.4-staging.<old>" + patch → strip to 0.1.4 → bump to 0.1.5.
  test("an existing -staging suffix is stripped before bumping", () => {
    expect(
      stagingVersion({ current: "0.1.4-staging.20260101000000", kind: "patch", stamp: STAMP }),
    ).toBe("0.1.5-staging.20260624103000");
  });

  test("an arbitrary -prerelease suffix is also stripped before bumping", () => {
    expect(stagingVersion({ current: "0.1.4-rc.2", kind: "patch", stamp: STAMP })).toBe(
      "0.1.5-staging.20260624103000",
    );
  });
});

describe("stagingVersion — cross-module contract pin", () => {
  test("output is recognized as the staging channel", () => {
    expect(channelOf(stagingVersion({ current: "0.1.3", kind: "patch", stamp: STAMP }))).toBe(
      "staging",
    );
    expect(channelOf(stagingVersion({ current: "1.0.0", kind: "minor", stamp: STAMP }))).toBe(
      "staging",
    );
  });

  test("a later stamp ranks newer than an earlier one at the same core", () => {
    const s1 = "20260624103000";
    const s2 = "20260624110000"; // s1 < s2
    const older = stagingVersion({ current: "0.1.3", kind: "patch", stamp: s1 });
    const newer = stagingVersion({ current: "0.1.3", kind: "patch", stamp: s2 });
    expect(isNewer(newer, older)).toBe(true);
    expect(isNewer(older, newer)).toBe(false);
  });
});

describe("staging-version CLI: base from explicit arg, else package.json", () => {
  // The direct-run CLI takes an optional 3rd arg `current`: release.sh passes the
  // origin/<default> version so repeated staging cuts bump a constant base. Spawn
  // the real script so this covers the import.meta.main branch end to end.
  // fileURLToPath (not URL.pathname) so a checkout dir with spaces/special chars
  // decodes correctly instead of feeding bun a percent-encoded path.
  const scriptPath = fileURLToPath(new URL("./staging-version.ts", import.meta.url));
  const CLI_STAMP = "20260625120000";

  const run = (...args: string[]) => {
    const { stdout, exitCode } = Bun.spawnSync(["bun", scriptPath, ...args]);
    return { out: stdout.toString().trim(), exitCode };
  };

  test("explicit current 0.1.4 + patch bumps the given base, not package.json", () => {
    const { out, exitCode } = run("patch", CLI_STAMP, "0.1.4");
    expect(exitCode).toBe(0);
    expect(out).toBe(`0.1.5-staging.${CLI_STAMP}`);
  });

  test("explicit current 1.2.3 + minor bumps the given base", () => {
    const { out, exitCode } = run("minor", CLI_STAMP, "1.2.3");
    expect(exitCode).toBe(0);
    expect(out).toBe(`1.3.0-staging.${CLI_STAMP}`);
  });

  test("no current arg falls back to package.json (shape only, not pinned)", () => {
    const { out, exitCode } = run("patch", CLI_STAMP);
    expect(exitCode).toBe(0);
    expect(out).toMatch(new RegExp(`^\\d+\\.\\d+\\.\\d+-staging\\.${CLI_STAMP}$`));
  });

  test("empty-string current arg falls back to package.json, same shape", () => {
    const { out, exitCode } = run("patch", CLI_STAMP, "");
    expect(exitCode).toBe(0);
    expect(out).toMatch(new RegExp(`^\\d+\\.\\d+\\.\\d+-staging\\.${CLI_STAMP}$`));
  });
});

describe("stagingVersion — throws on malformed input", () => {
  test("throws on a non-digit stamp", () => {
    expect(() => stagingVersion({ current: "0.1.3", kind: "patch", stamp: "abc" })).toThrow();
    expect(() => stagingVersion({ current: "0.1.3", kind: "patch", stamp: "12a3" })).toThrow();
  });

  test("throws on an empty stamp", () => {
    expect(() => stagingVersion({ current: "0.1.3", kind: "patch", stamp: "" })).toThrow();
  });

  test("throws on an unparseable current version", () => {
    expect(() => stagingVersion({ current: "not-a-version", kind: "patch", stamp: STAMP })).toThrow();
    expect(() => stagingVersion({ current: "1.2", kind: "patch", stamp: STAMP })).toThrow();
    expect(() => stagingVersion({ current: "1.2.x", kind: "patch", stamp: STAMP })).toThrow();
  });
});
