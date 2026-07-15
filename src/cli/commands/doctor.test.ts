import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MANAGED_MARKER } from "../install/assets.js";
import {
  protocolSkillCheck,
  type ProtocolSkillIdentity,
  type WrapperCandidate,
  wrapperCheck,
} from "./doctor.js";

// wrapperCheck is the load-bearing new logic: it accepts the otacon protocol skill at
// EITHER the user or the project path (when in a repo) and names the scope that
// satisfied it. These tests drive it with real temp files so the present/absent + marker
// gate is exercised end to end, with no daemon and no dependence on the real ~ state
// (the user candidate points at a temp dir that has no wrapper).
let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "otacon-doctor-")));
});

describe("dual-skill diagnosis", () => {
  const identityFor = (skill: "otacon" | "otacon-review"): ProtocolSkillIdentity => ({
    managedMarker: MANAGED_MARKER,
    frontmatterName: skill,
    commandMarker: skill === "otacon" ? "otacon start --title" : "otacon review start --pr",
  });
  const candidatesFor = (skill: "otacon" | "otacon-review"): WrapperCandidate[] => [
    { path: join(dir, "user", ".codex", "skills", skill, "SKILL.md"), scope: "user" },
    { path: join(dir, "repo", ".codex", "skills", skill, "SKILL.md"), scope: "project" },
  ];

  test("reports the plan skill healthy and the missing review skill with reinstall guidance", () => {
    writeWrapper(candidatesFor("otacon")[0]!.path, "otacon");
    const plan = protocolSkillCheck("codex", "otacon", candidatesFor("otacon"), identityFor("otacon"));
    const review = protocolSkillCheck("codex", "otacon-review", candidatesFor("otacon-review"), identityFor("otacon-review"));
    expect(plan.status).toBe("ok");
    expect(review.status).toBe("warn");
    expect(review.detail).toContain("otacon-review protocol skill not found for codex");
    expect(review.detail).toContain("otacon install --agent codex");
    expect(review.detail).toContain("install both Otacon skills");
  });

  test("reports both missing skills independently with the same actionable reinstall", () => {
    const checks = (["otacon", "otacon-review"] as const).map((skill) =>
      protocolSkillCheck("codex", skill, candidatesFor(skill), identityFor(skill)));
    expect(checks.map((check) => check.status)).toEqual(["warn", "warn"]);
    expect(checks[0]!.detail).toContain("otacon protocol skill not found for codex");
    expect(checks[1]!.detail).toContain("otacon-review protocol skill not found for codex");
    for (const check of checks) expect(check.detail).toContain("otacon install --agent codex");
  });

  test("accepts both skills independently from project scope", () => {
    writeWrapper(candidatesFor("otacon")[1]!.path, "otacon");
    writeWrapper(candidatesFor("otacon-review")[1]!.path, "otacon-review");
    for (const skill of ["otacon", "otacon-review"] as const) {
      const check = protocolSkillCheck("codex", skill, candidatesFor(skill), identityFor(skill));
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("(project)");
    }
  });

  test("rejects swapped managed skills with the wrong identity or command protocol", () => {
    writeWrapper(candidatesFor("otacon")[0]!.path, "otacon-review");
    writeWrapper(candidatesFor("otacon-review")[0]!.path, "otacon");
    expect(protocolSkillCheck(
      "codex",
      "otacon",
      candidatesFor("otacon"),
      identityFor("otacon"),
    ).status).toBe("warn");
    expect(protocolSkillCheck(
      "codex",
      "otacon-review",
      candidatesFor("otacon-review"),
      identityFor("otacon-review"),
    ).status).toBe("warn");
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a marked SKILL.md at `path` (creating parents) so wrapperPresent() sees it. */
function writeWrapper(path: string, skill: "otacon" | "otacon-review" = "otacon"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const command = skill === "otacon" ? "otacon start --title" : "otacon review start --pr";
  writeFileSync(path, `---\nname: ${skill}\n---\n${command}\n<!-- ${MANAGED_MARKER} -->\n`);
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
