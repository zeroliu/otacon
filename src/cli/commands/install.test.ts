import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CliError } from "../output.js";
import { installCommand } from "./install.js";

// These tests exercise only --project, which roots every write under the cwd's git
// repo (never the user home), so they stay hermetic by sandboxing process.cwd() under
// a fresh temp repo. (User-scope path resolution can't be sandboxed by mutating $HOME
// at runtime — os.homedir() ignores it on macOS — so user-scope writes are covered by
// locations.test.ts instead.) stdout is captured to parse the one JSON line install
// prints; stderr notices are swallowed to keep the test output clean.
let cwd: string;
let savedCwd: string;
let savedCodexHome: string | undefined;
let savedXdg: string | undefined;
let stdout: string;
let stdoutWrite: typeof process.stdout.write;
let stderrWrite: typeof process.stderr.write;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "otacon-install-cwd-")));
  savedCwd = process.cwd();
  savedCodexHome = process.env.CODEX_HOME;
  savedXdg = process.env.XDG_CONFIG_HOME;
  // Pin codex/opencode env so project scope provably ignores them (it must root
  // under the repo, not these bases).
  process.env.CODEX_HOME = "/should/be/ignored";
  process.env.XDG_CONFIG_HOME = "/should/be/ignored";
  process.chdir(cwd);
  stdout = "";
  stdoutWrite = process.stdout.write.bind(process.stdout);
  stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = stdoutWrite;
  process.stderr.write = stderrWrite;
  process.chdir(savedCwd);
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(cwd, { recursive: true, force: true });
});

const lastJson = () => JSON.parse(stdout.trim().split("\n").at(-1) as string);
const REL = join("skills", "otacon", "SKILL.md");

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
}

describe("install --project", () => {
  test("inside a repo resolves project paths and reports project scope", async () => {
    gitInit(cwd);
    const code = await installCommand(["--all", "--project"]);
    expect(code).toBe(0);

    expect(existsSync(join(cwd, ".claude", REL))).toBe(true);
    // Project scope roots codex/opencode under the repo, ignoring $CODEX_HOME /
    // $XDG_CONFIG_HOME (both pinned to /should/be/ignored in beforeEach).
    expect(existsSync(join(cwd, ".codex", REL))).toBe(true);
    expect(existsSync(join(cwd, ".opencode", REL))).toBe(true);
    // The project claude install writes ONLY the skill wrapper — no Stop hook script.
    expect(existsSync(join(cwd, ".claude", "hooks", "otacon-stop.sh"))).toBe(false);

    const out = lastJson();
    expect(out.ok).toBe(true);
    expect(out.scope).toBe("project");
    // The hooks report is user-only; a project install must neither offer nor report it.
    expect(out.hooks).toBeUndefined();
    const claude = out.installed.find((i: { agent: string }) => i.agent === "claude");
    expect(claude.files).toEqual([join(cwd, ".claude", REL)]);
    // Project-scope wrappers are always copied (a committed file cannot symlink to a
    // machine-local global path), so every reported mode is "copy".
    for (const entry of out.installed as { mode: string }[]) {
      expect(entry.mode).toBe("copy");
    }
  });

  test("--project --agent claude writes only the project skill wrapper", async () => {
    gitInit(cwd);
    await installCommand(["--agent", "claude", "--project"]);
    expect(readFileSync(join(cwd, ".claude", REL), "utf8")).toContain("otacon start --title");
    expect(existsSync(join(cwd, ".claude", "hooks", "otacon-stop.sh"))).toBe(false);
  });

  test("outside a git repo exits 2 with a clear message", async () => {
    // cwd is a bare temp dir, not a git repo.
    try {
      await installCommand(["--agent", "claude", "--project"]);
      throw new Error("expected installCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const cli = error as CliError;
      expect(cli.exitCode).toBe(2);
      expect(cli.code).toBe("E_USAGE");
      expect(cli.message).toContain("must run inside a git repo");
    }
  });

  test("--hooks --project exits 2", async () => {
    gitInit(cwd);
    try {
      await installCommand(["--agent", "claude", "--project", "--hooks"]);
      throw new Error("expected installCommand to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const cli = error as CliError;
      expect(cli.exitCode).toBe(2);
      expect(cli.message).toContain("cannot be combined with --project");
    }
  });
});
