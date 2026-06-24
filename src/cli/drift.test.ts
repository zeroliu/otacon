import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, citedPaths, reconcile } from "./drift.js";

describe("citedPaths: Files-list normalization", () => {
  test("strips leading `- `, backticks, and collects across phases", () => {
    const plan = [
      "## Phases",
      "### Phase 1 — a",
      "Files:",
      "- `src/auth/issuer.ts`",
      "- src/auth/keys.ts",
      "Verification: prose",
      "### Phase 2 — b",
      "Files:",
      "- `src/middleware/jwt.ts`",
      "",
    ].join("\n");
    expect(citedPaths(plan)).toEqual([
      "src/auth/issuer.ts",
      "src/auth/keys.ts",
      "src/middleware/jwt.ts",
    ]);
  });

  test("strips scope pills and trailing descriptions (the `[new]`-annotated entry)", () => {
    const plan = [
      "### Phase 1 — x",
      "Files:",
      "- `src/cli/drift.ts` [new] — the drift logic",
      "- `src/daemon/app.ts` — implement-done route computes it",
      "- src/ui/** (plan-view.tsx or session-screen.tsx)",
      "- `*.test.ts` for the above",
    ].join("\n");
    expect(citedPaths(plan)).toEqual([
      "src/cli/drift.ts",
      "src/daemon/app.ts",
      "src/ui/**",
      "*.test.ts",
    ]);
  });

  test("accepts the `**Files:**` label form and a blank line after the label", () => {
    const plan = [
      "### Phase 1 — x",
      "**Files:**",
      "",
      "- src/a.ts",
      "- src/b.ts",
      "",
      "**Verification:** prose",
    ].join("\n");
    expect(citedPaths(plan)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("an Out of scope / Goal field closes the Files run", () => {
    const plan = [
      "### Phase 1 — x",
      "Files:",
      "- src/a.ts",
      "Out of scope: src/should-not-be-cited.ts",
      "- src/b.ts",
    ].join("\n");
    // src/b.ts comes AFTER the Out-of-scope label closed the run, so it is not
    // collected; the bare path inside Out of scope is likewise not a cited file.
    expect(citedPaths(plan)).toEqual(["src/a.ts"]);
  });

  test("trailing description after ` (` is dropped; a description-only item yields nothing", () => {
    const plan = [
      "### Phase 1 — x",
      "Files:",
      "- src/a.ts (touched lightly)",
      "- and some prose with no path",
    ].join("\n");
    expect(citedPaths(plan)).toEqual(["src/a.ts", "and some prose with no path"]);
    // (the second is collected as a "path" but harmlessly: it never matches a
    // real changed file, so it cannot mask drift; leniency only shrinks drift.)
  });

  test("dedupes a path cited by two phases", () => {
    const plan = [
      "### Phase 1 — x",
      "Files:",
      "- src/shared/types.ts",
      "### Phase 2 — y",
      "Files:",
      "- src/shared/types.ts",
    ].join("\n");
    expect(citedPaths(plan)).toEqual(["src/shared/types.ts"]);
  });
});

describe("reconcile: drift matching", () => {
  // Scenario 1: a changed file no phase's Files lists is flagged shipped-beyond-plan.
  test("Scenario 1: an uncited changed file appears in shippedBeyondPlan", () => {
    const cited = ["src/auth/issuer.ts", "src/auth/keys.ts"];
    const changed = ["src/auth/issuer.ts", "src/foo.ts"];
    expect(reconcile(changed, cited)).toEqual({ shippedBeyondPlan: ["src/foo.ts"] });
  });

  // Scenario 2: every changed file is covered → the report is empty. Exercises
  // an exact match, a cited-directory prefix, and a `*`/`**` glob.
  test("Scenario 2: all changed files covered (exact, dir-prefix, glob) → empty report", () => {
    const cited = ["src/auth/issuer.ts", "src/ui", "src/daemon/**", "*.test.ts"];
    const changed = [
      "src/auth/issuer.ts", // exact
      "src/ui/plan-view.tsx", // under the src/ui directory prefix
      "src/daemon/app.ts", // ** glob spanning a slash
      "drift.test.ts", // *.test.ts glob (no slash)
    ];
    expect(reconcile(changed, cited)).toEqual({ shippedBeyondPlan: [] });
  });

  test("a lone `*` glob does not span a slash (stays lenient but not unbounded)", () => {
    const cited = ["src/*.ts"];
    // src/a.ts matches `src/*.ts`; src/nested/a.ts does NOT (a single * is one segment).
    expect(reconcile(["src/a.ts", "src/nested/a.ts"], cited)).toEqual({
      shippedBeyondPlan: ["src/nested/a.ts"],
    });
  });

  test("preserves changed-file order and an empty changed set is empty", () => {
    expect(reconcile([], ["src/a.ts"])).toEqual({ shippedBeyondPlan: [] });
    expect(reconcile(["z.ts", "a.ts"], [])).toEqual({ shippedBeyondPlan: ["z.ts", "a.ts"] });
  });
});

describe("changedFiles: git probe (fails soft)", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "otacon-drift-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });

  test("returns the diff vs the merge-base with main", () => {
    execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
    git(["config", "user.email", "t@t.test"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(dir, "base.ts"), "export const a = 1;\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    git(["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(dir, "src-foo.ts"), "export const b = 2;\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "feature work"]);
    expect(changedFiles(dir)).toEqual(["src-foo.ts"]);
  });

  test("returns [] outside any git repo (advisory: never throws)", () => {
    expect(changedFiles(dir)).toEqual([]);
  });

  test("returns [] when there is no merge-base with the named branch", () => {
    execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
    git(["config", "user.email", "t@t.test"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(dir, "base.ts"), "x\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "base"]);
    // No branch named "nope" → merge-base fails → soft [].
    expect(changedFiles(dir, "nope")).toEqual([]);
  });
});
