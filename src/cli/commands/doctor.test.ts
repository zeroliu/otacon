import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MANAGED_MARKER } from "../install/assets.js";
import { type WrapperCandidate, wrapperCheck } from "./doctor.js";

// wrapperCheck is the load-bearing new logic: it accepts the otacon protocol skill at
// EITHER the user or the project path (when in a repo) and names the scope that
// satisfied it. These tests drive it with real temp files so the present/absent + marker
// gate is exercised end to end, with no daemon and no dependence on the real ~ state
// (the user candidate points at a temp dir that has no wrapper).
let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "otacon-doctor-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a marked SKILL.md at `path` (creating parents) so wrapperPresent() sees it. */
function writeWrapper(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `# otacon\n<!-- ${MANAGED_MARKER} -->\n`);
}

describe("wrapperCheck scope selection", () => {
  const userPath = () => join(dir, "user", ".claude", "skills", "otacon", "SKILL.md");
  const projectPath = () => join(dir, "repo", ".claude", "skills", "otacon", "SKILL.md");
  const candidates = (): WrapperCandidate[] => [
    { path: userPath(), scope: "user" },
    { path: projectPath(), scope: "project" },
  ];

  test("ok citing the project path when only the project wrapper is present", () => {
    writeWrapper(projectPath());
    const check = wrapperCheck("wrapper-claude", candidates(), MANAGED_MARKER);
    expect(check.status).toBe("ok");
    expect(check.detail).toBe(`${projectPath()} (project)`);
  });

  test("ok citing the user path when only the user wrapper is present", () => {
    writeWrapper(userPath());
    const check = wrapperCheck("wrapper-claude", candidates(), MANAGED_MARKER);
    expect(check.status).toBe("ok");
    expect(check.detail).toBe(`${userPath()} (user)`);
  });

  test("prefers the user candidate when both are present (first hit wins)", () => {
    writeWrapper(userPath());
    writeWrapper(projectPath());
    const check = wrapperCheck("wrapper-claude", candidates(), MANAGED_MARKER);
    expect(check.detail).toBe(`${userPath()} (user)`);
  });

  test("a file without the managed marker does not count as present", () => {
    mkdirSync(join(projectPath(), ".."), { recursive: true });
    writeFileSync(projectPath(), "# not an otacon wrapper\n");
    const check = wrapperCheck("wrapper-claude", candidates(), MANAGED_MARKER);
    expect(check.status).toBe("warn");
  });

  test("warn names the otacon protocol skill, lists both paths, and mentions --project", () => {
    const check = wrapperCheck("wrapper-claude", candidates(), MANAGED_MARKER);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("otacon protocol skill not found for claude");
    expect(check.detail).toContain(userPath());
    expect(check.detail).toContain(projectPath());
    expect(check.detail).toContain("otacon install --agent claude");
    expect(check.detail).toContain("add --project to install it into this repo");
  });

  test("with only a user candidate (not in a repo) the warn omits the --project hint", () => {
    const check = wrapperCheck(
      "wrapper-codex",
      [{ path: userPath(), scope: "user" }],
      MANAGED_MARKER,
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("otacon protocol skill not found for codex");
    expect(check.detail).not.toContain("--project");
  });
});
