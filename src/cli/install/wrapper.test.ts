import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeSkillAsset } from "../../../scripts/gen-skill-asset.js";
import { skillMd } from "./assets.js";
import {
  ensureSkill,
  packagedSkillPath,
  refreshInstalledWrappers,
} from "./wrapper.js";

// A unique temp scratch dir per test; the caller cleans it up in a finally.
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "otacon-ensure-wrapper-"));
}

// A real packaged-asset file (what `ensureSkill` links or copies from).
function pkgFile(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, skillMd());
  return path;
}

// In the source/test context this module resolves to src/skills/otacon/SKILL.md,
// which never exists, so the packaged path is unreachable, deterministically
// undefined. That is the source-run behavior callers rely on to copy instead.
test("packagedSkillPath is undefined when run from source", () => {
  expect(packagedSkillPath()).toBeUndefined();
});

// Drift guard: the shipped asset must byte-equal skillMd(). writeSkillAsset() is the
// exact write the build runs, so exercising it against a temp target proves the
// generator emits current protocol text (no stale copy in the package).
test("writeSkillAsset writes a byte-equal copy of skillMd()", () => {
  const target = join(tmpdir(), `otacon-skill-asset-${process.pid}-${Date.now()}.md`);
  try {
    const written = writeSkillAsset(target);
    expect(written).toBe(target);
    expect(readFileSync(target, "utf8")).toBe(skillMd());
  } finally {
    rmSync(target, { force: true });
  }
});

// User scope + a real packaged asset -> a symlink for its complete skill directory.
// A second identical call is a no-op (idempotent convergence).
test("ensureSkill links a complete user skill directory", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(dir);
    const wrapper = join(dir, "skills", "otacon", "SKILL.md");

    const first = ensureSkill(wrapper, "user", pkg);
    expect(first).toEqual({ mode: "symlink", changed: true });
    expect(lstatSync(dirname(wrapper)).isSymbolicLink()).toBe(true);
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(false);
    expect(realpathSync(dirname(wrapper))).toBe(realpathSync(dirname(pkg)));
    // The protocol text is reachable THROUGH the link (readFileSync follows it).
    expect(readFileSync(wrapper, "utf8")).toBe(skillMd());

    const second = ensureSkill(wrapper, "user", pkg);
    expect(second).toEqual({ mode: "symlink", changed: false });
    expect(lstatSync(dirname(wrapper)).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// User scope but no packaged path (source/npx) → there is nothing stable to link to,
// so the wrapper is a plain copy of skillMd().
test("ensureSkill copies when there is no packaged path", () => {
  const dir = scratch();
  try {
    const wrapper = join(dir, "skills", "otacon", "SKILL.md");
    const result = ensureSkill(wrapper, "user", undefined);
    expect(result).toEqual({ mode: "copy", changed: true });
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(false);
    expect(readFileSync(wrapper, "utf8")).toBe(skillMd());
    // Idempotent: a matching copy is a no-op.
    expect(ensureSkill(wrapper, "user", undefined)).toEqual({
      mode: "copy",
      changed: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Project scope always copies, even with a real packaged file: a committed wrapper
// must be machine-independent and cannot point at a machine-local global path.
test("ensureSkill copies project-scope skills even with a packaged file", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(dir);
    const wrapper = join(dir, "proj", ".claude", "skills", "otacon", "SKILL.md");
    const result = ensureSkill(wrapper, "project", pkg);
    expect(result).toEqual({ mode: "copy", changed: true });
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(false);
    expect(readFileSync(wrapper, "utf8")).toBe(skillMd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// User scope + a real packaged file, but the linker throws (Windows/EPERM/EXDEV) →
// fall through to a copy. Proves the symlink-unsupported fallback.
test("ensureSkill falls back to a copy when symlinking throws", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(dir);
    const wrapper = join(dir, "skills", "otacon", "SKILL.md");
    const throwing = () => {
      throw Object.assign(new Error("EPERM: operation not permitted, symlink"), {
        code: "EPERM",
      });
    };
    const result = ensureSkill(wrapper, "user", pkg, throwing);
    expect(result).toEqual({ mode: "copy", changed: true });
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(false);
    expect(readFileSync(wrapper, "utf8")).toBe(skillMd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Downgrade self-heal: an existing symlink, then a call with no packaged path,
// becomes a regular-file copy (the stale link is cleared first).
test("ensureSkill downgrades a symlink to a copy when the packaged path disappears", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(dir);
    const wrapper = join(dir, "skills", "otacon", "SKILL.md");

    expect(ensureSkill(wrapper, "user", pkg).mode).toBe("symlink");
    expect(lstatSync(dirname(wrapper)).isSymbolicLink()).toBe(true);

    const downgraded = ensureSkill(wrapper, "user", undefined);
    expect(downgraded).toEqual({ mode: "copy", changed: true });
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(false);
    expect(readFileSync(wrapper, "utf8")).toBe(skillMd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Upgrade path for existing installs: replace the old real `otacon/` directory whose
// SKILL.md alone is linked with the universal directory-level link.
test("ensureSkill migrates a legacy file link to the skill directory", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(join(dir, "package", "otacon"));
    const wrapper = join(dir, "home", ".codex", "skills", "otacon", "SKILL.md");
    mkdirSync(dirname(wrapper), { recursive: true });
    symlinkSync(pkg, wrapper);

    const result = ensureSkill(wrapper, "user", pkg);
    expect(result).toEqual({ mode: "symlink", changed: true });
    expect(lstatSync(dirname(wrapper)).isSymbolicLink()).toBe(true);
    expect(realpathSync(dirname(wrapper))).toBe(realpathSync(dirname(pkg)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSkill keeps project installs as portable copies", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(join(dir, "package", "otacon"));
    const wrapper = join(dir, "repo", ".codex", "skills", "otacon", "SKILL.md");
    const result = ensureSkill(wrapper, "project", pkg);
    expect(result).toEqual({ mode: "copy", changed: true });
    expect(lstatSync(dirname(wrapper)).isSymbolicLink()).toBe(false);
    expect(lstatSync(wrapper).isSymbolicLink()).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── refreshInstalledWrappers ────────────────────────────────────────────────
//
// These exercise the start-time self-heal pass in a CHILD process so the whole HOME
// is hermetic. Under Bun os.homedir() is fixed at process start and does NOT track a
// later process.env.HOME mutation, so an in-process $HOME override would not redirect
// claudeSkillPath(), and the real ~/.claude could be touched. Spawning a fresh `bun`
// with HOME / CODEX_HOME / XDG_CONFIG_HOME all pointed at a temp dir is the only way
// to redirect every user-scope candidate at once, exactly as the install e2e does.
//
// The child sets up the fixture (env RF_* describe what to create), runs
// refreshInstalledWrappers with the injected seams, and prints the returned list plus
// post-state on stdout as one JSON line. isSourceRun() is true in this tree (no dist
// sibling), so `sourceRun` is injected to drive the body except in the source-run test.

// The child driver: a self-contained bun program. It reads RF_* env to build a
// fixture (a user-scope wrapper under $HOME, or a project-scope wrapper under
// RF_CWD's repo root), calls refreshInstalledWrappers, then reports JSON. Running
// every case in the child keeps the real ~/.claude (and ~/.codex, ~/.config) off the
// candidate list for the in-process suite: HOME/CODEX_HOME/XDG_CONFIG_HOME are all
// temp here, and the project case's user candidates resolve to the empty temp HOME.
const REFRESH_DRIVER = `
import { lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { skillMd } from ${JSON.stringify(join(import.meta.dir, "assets.ts"))};
import { claudeSkillPath, codexSkillPath, opencodeSkillPath } from ${JSON.stringify(join(import.meta.dir, "locations.ts"))};
import { refreshInstalledWrappers } from ${JSON.stringify(join(import.meta.dir, "wrapper.ts"))};

const env = process.env;
// Resolve a path WITHOUT following a final symlink: realpath the parent dir, rejoin
// the basename. Lets us compare a wrapper that became a symlink by its own location,
// not its link target (and absorbs /var -> /private/var on macOS for the repo root).
const resolveSelf = (p) => join(realpathSync(dirname(p)), basename(p));
const pkg = env.RF_PKG;
// A user-scope wrapper roots at the child's temp HOME; a project-scope one roots at
// RF_CWD (a temp repo with a .git dir), via claudeSkillPath's project branch.
const skillPath = env.RF_AGENT === "codex"
  ? codexSkillPath
  : env.RF_AGENT === "opencode"
    ? opencodeSkillPath
    : claudeSkillPath;
const wrapper = env.RF_CWD
  ? skillPath({ kind: "project", root: env.RF_CWD })
  : skillPath();

if (env.RF_FIXTURE === "dir-symlink") {
  mkdirSync(dirname(dirname(wrapper)), { recursive: true });
  symlinkSync(dirname(pkg), dirname(wrapper), "dir");
} else if (env.RF_FIXTURE === "dangling-dir-symlink") {
  mkdirSync(dirname(dirname(wrapper)), { recursive: true });
  symlinkSync(dirname(pkg) + "-missing", dirname(wrapper), "dir");
} else {
  mkdirSync(dirname(wrapper), { recursive: true });
  if (env.RF_FIXTURE === "copy") writeFileSync(wrapper, skillMd());
  else if (env.RF_FIXTURE === "stale-copy") writeFileSync(wrapper, "STALE PROTOCOL\\n" + skillMd());
  else if (env.RF_FIXTURE === "symlink") symlinkSync(pkg, wrapper);
  else if (env.RF_FIXTURE === "foreign") writeFileSync(wrapper, "# my own notes, not an otacon wrapper\\n");
}

const deps = { pkgPath: pkg, sourceRun: () => env.RF_SOURCE_RUN === "1" };
if (env.RF_CWD) deps.cwd = env.RF_CWD;

const result = refreshInstalledWrappers(deps);

// lstat the wrapper itself (does NOT follow the link), so a symlink reads as one.
const info = lstatSync(wrapper, { throwIfNoEntry: false });
const skillDirInfo = lstatSync(dirname(wrapper), { throwIfNoEntry: false });
const out = {
  // Resolve list paths by their own location (not a link target); findRepoRoot
  // realpath-resolves the project root, so a raw string compare would miss.
  result: result.map((r) => ({ mode: r.mode, real: resolveSelf(r.path) })),
  exists: info !== undefined,
  isSymlink: info !== undefined && info.isSymbolicLink(),
  content: info !== undefined ? readFileSync(wrapper, "utf8") : null,
  // The link's TARGET (followed), to assert a promotion points at the package.
  target: info !== undefined && info.isSymbolicLink() ? realpathSync(wrapper) : null,
  skillDirIsSymlink: skillDirInfo !== undefined && skillDirInfo.isSymbolicLink(),
  skillDirTarget:
    skillDirInfo !== undefined && skillDirInfo.isSymbolicLink()
      ? realpathSync(dirname(wrapper))
      : null,
  // The wrapper's own resolved location, to match against result[].real.
  wrapperReal: resolveSelf(wrapper),
};
process.stdout.write(JSON.stringify(out));
`;

interface RefreshChildOut {
  result: { mode: string; real: string }[];
  exists: boolean;
  isSymlink: boolean;
  content: string | null;
  target: string | null;
  skillDirIsSymlink: boolean;
  skillDirTarget: string | null;
  wrapperReal: string;
}

// Spawn the driver under a hermetic temp HOME (every user-scope candidate roots
// there). `fixture` names the pre-state to create; `sourceRun` forces the source-run
// skip; `cwd` (a temp repo root) switches the fixture to project scope. Returns the
// child's reported post-state. Cleans the temp HOME after.
function runRefreshChild(opts: {
  fixture:
    | "copy"
    | "stale-copy"
    | "symlink"
    | "dir-symlink"
    | "dangling-dir-symlink"
    | "foreign";
  sourceRun?: boolean;
  pkg: string;
  cwd?: string;
  agent?: "claude" | "codex" | "opencode";
}): RefreshChildOut {
  const home = mkdtempSync(join(tmpdir(), "otacon-refresh-home-"));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      XDG_CONFIG_HOME: join(home, ".config"),
      RF_PKG: opts.pkg,
      RF_FIXTURE: opts.fixture,
      RF_SOURCE_RUN: opts.sourceRun ? "1" : "0",
      RF_AGENT: opts.agent ?? "claude",
    };
    if (opts.cwd !== undefined) env.RF_CWD = opts.cwd;
    const child = spawnSync(process.execPath, ["-"], { input: REFRESH_DRIVER, encoding: "utf8", env });
    if (child.status !== 0) {
      throw new Error(`refresh child failed (${child.status}): ${child.stderr}`);
    }
    return JSON.parse(child.stdout) as RefreshChildOut;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Source-run skip / dogfood safety: sourceRun true returns [] and leaves a present
// stale wrapper UNTOUCHED, so a source-mode `start` never rewrites the committed file.
test("refreshInstalledWrappers is a no-op on a source run", () => {
  const dir = scratch();
  try {
    const out = runRefreshChild({ fixture: "stale-copy", sourceRun: true, pkg: pkgFile(dir) });
    expect(out.result).toEqual([]);
    expect(out.isSymlink).toBe(false); // still the stale copy, untouched
    expect(out.content).toBe(`STALE PROTOCOL\n${skillMd()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A stale user-scope COPY is promoted to a symlink to the packaged directory, and the
// returned list reports it (the copy-fallback / legacy migration the pass exists for).
test("refreshInstalledWrappers promotes a user-scope copy to a directory symlink", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(dir);
    const out = runRefreshChild({ fixture: "copy", pkg });
    expect(out.isSymlink).toBe(false);
    expect(out.skillDirIsSymlink).toBe(true);
    expect(out.skillDirTarget).toBe(realpathSync(dirname(pkg)));
    expect(out.result).toContainEqual({ mode: "symlink", real: out.wrapperReal });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshInstalledWrappers migrates an installed file symlink", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(join(dir, "package", "otacon"));
    const out = runRefreshChild({ fixture: "symlink", pkg, agent: "opencode" });
    expect(out.skillDirIsSymlink).toBe(true);
    expect(out.skillDirTarget).toBe(realpathSync(dirname(pkg)));
    expect(out.content).toBe(skillMd());
    expect(out.result).toContainEqual({ mode: "symlink", real: out.wrapperReal });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A correct user-scope directory symlink is INERT: nothing changes, it stays linked, and it
// is not in the returned list (the common symlink-install case costs nothing).
test("refreshInstalledWrappers leaves a correct directory symlink untouched", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(dir);
    const out = runRefreshChild({ fixture: "dir-symlink", pkg, agent: "codex" });
    expect(out.result).toEqual([]); // no change, not listed
    expect(out.isSymlink).toBe(false);
    expect(out.skillDirIsSymlink).toBe(true);
    expect(out.skillDirTarget).toBe(realpathSync(dirname(pkg)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshInstalledWrappers repairs a dangling directory symlink", () => {
  const dir = scratch();
  try {
    const pkg = pkgFile(join(dir, "package", "otacon"));
    const out = runRefreshChild({ fixture: "dangling-dir-symlink", pkg });
    expect(out.skillDirIsSymlink).toBe(true);
    expect(out.skillDirTarget).toBe(realpathSync(dirname(pkg)));
    expect(out.content).toBe(skillMd());
    expect(out.result).toContainEqual({ mode: "symlink", real: out.wrapperReal });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A foreign SKILL.md (no managed marker) is left alone: the pass heals only files it
// owns, never clobbering a hand-written wrapper the user happens to keep there.
test("refreshInstalledWrappers ignores a foreign file", () => {
  const dir = scratch();
  try {
    const foreign = "# my own notes, not an otacon wrapper\n";
    const out = runRefreshChild({ fixture: "foreign", pkg: pkgFile(dir) });
    expect(out.result).toEqual([]);
    expect(out.isSymlink).toBe(false);
    expect(out.content).toBe(foreign); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A drifted PROJECT-scope copy is rewritten to current skillMd(), still a copy, never
// a machine-local symlink. cwd points at a temp dir findRepoRoot accepts (has .git);
// the .claude project wrapper there starts as a marker-bearing copy with OLD content.
test("refreshInstalledWrappers rewrites a drifted project-scope copy", () => {
  const dir = scratch();
  const root = mkdtempSync(join(tmpdir(), "otacon-refresh-repo-"));
  try {
    // A real repo root: findRepoRoot runs `git rev-parse --show-toplevel`, which
    // needs an actual git dir (a bare `.git` folder is not enough).
    execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: "ignore" });
    const out = runRefreshChild({ fixture: "stale-copy", pkg: pkgFile(dir), cwd: root });
    expect(out.content).toBe(skillMd()); // rewritten to current text
    expect(out.isSymlink).toBe(false); // still a copy, never a machine-local symlink
    expect(out.result).toContainEqual({ mode: "copy", real: out.wrapperReal });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
