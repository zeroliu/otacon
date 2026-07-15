// Resolves each in-package SKILL.md asset whose containing skill directory user
// installs link to (project/fallback installs copy the file instead).
// A symlink target must be a STABLE on-disk path, so only the packaged directory qualifies;
// when there is no such file (running from source, or an ephemeral npx cache that a
// later invocation may have wiped), callers must fall back to COPYING instead.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isSourceRun } from "../client.js";
import { notice } from "../output.js";
import { findRepoRoot } from "../session.js";
import { MANAGED_MARKER, reviewSkillMd, skillMd } from "./assets.js";
import {
  claudeSkillPath,
  codexSkillPath,
  type OtaconSkillName,
  opencodeSkillPath,
} from "./locations.js";

export const OTACON_SKILLS: readonly OtaconSkillName[] = ["otacon", "otacon-review"];

function skillContent(skill: OtaconSkillName): string {
  return skill === "otacon" ? skillMd() : reviewSkillMd();
}

/**
 * The absolute path of the packaged `SKILL.md` asset, or `undefined` when no stable
 * packaged copy exists (so callers copy `skillMd()` instead of symlinking).
 *
 * Resolution is relative to THIS module's compiled location: from the installed
 * `dist/cli/install/wrapper.js` `../../skills/otacon/SKILL.md` is
 * `dist/skills/otacon/SKILL.md` (the file the build emits); from source
 * `src/cli/install/wrapper.ts` it is `src/skills/otacon/SKILL.md`, which never exists,
 * so a source run correctly returns `undefined`. Returns `undefined` when:
 * - the resolved path does not exist (source run, or asset not built); or
 * - the path lives under an ephemeral npx cache (an `_npx` segment): that dir is
 *   transient, so a symlink into it would dangle once npx prunes it; copy instead.
 * Never throws: any error resolves to `undefined`, the copy-fallback signal.
 */
export function packagedSkillPath(skill: OtaconSkillName = "otacon"): string | undefined {
  try {
    const path = fileURLToPath(
      new URL(`../../skills/${skill}/SKILL.md`, import.meta.url),
    );
    if (!existsSync(path)) return undefined;
    if (/[/\\]_npx[/\\]/.test(path)) return undefined;
    return path;
  } catch {
    return undefined;
  }
}

/** How a wrapper was materialized: a symlink to the packaged asset, or its copied text. */
export type WrapperMode = "symlink" | "copy";

/**
 * Converge the wrapper at `path` to its desired state and report how (idempotent).
 *
 * User-scope installs SYMLINK the complete skill directory to the packaged skill
 * directory, so a binary upgrade refreshes every skill asset for free. Claude Code,
 * Codex, and OpenCode all support this common layout; Codex specifically ignores a
 * symlink whose leaf is `SKILL.md`. Two cases fall back to a COPY of `skillMd()`:
 * - **Project scope** always copies. A `--project` wrapper is committed/shared, so it
 *   must be machine-independent: it cannot point at a machine-local global path that
 *   a teammate (or CI) does not have.
 * - **No stable packaged path** (`pkgPath` undefined: a source run, or an ephemeral
 *   npx cache `packagedSkillPath()` already rejected): there is nothing durable to
 *   link to, so copy the current text.
 * - **Symlinks unsupported here** (the `symlink` call throws EPERM/EXDEV/ENOSYS/etc.,
 *   e.g. Windows without privilege, or a cross-device link): fall through to a copy.
 *   The `symlink` parameter is a testability seam that also lets a test force this path.
 *
 * Convergence is idempotent: an already-correct symlink (same resolved target) or an
 * already-correct copy (same contents, a regular file not a symlink) is a no-op
 * (`changed: false`); anything else is removed and rewritten. A scope/availability
 * change between runs self-heals (a stale symlink becomes a copy, and vice versa)
 * because each branch first `rmSync`s whatever is in the way. `lstatSync` (not `stat`)
 * inspects the link itself, so a symlink is never mistaken for a regular file, and
 * `{ throwIfNoEntry: false }` makes a missing path a plain `undefined`, never a throw.
 */
export function ensureSkill(
  path: string,
  scope: "user" | "project",
  pkgPath: string | undefined = packagedSkillPath(),
  // testability seam: inject a throwing linker to exercise the copy fallback
  symlink: (target: string, linkPath: string) => void = (target, linkPath) =>
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir"),
): { mode: WrapperMode; changed: boolean } {
  return ensureNamedSkill("otacon", path, scope, pkgPath, symlink);
}

/** Converge one named skill without coupling the plan and review protocols. */
export function ensureNamedSkill(
  skill: OtaconSkillName,
  path: string,
  scope: "user" | "project",
  pkgPath: string | undefined = packagedSkillPath(skill),
  symlink: (target: string, linkPath: string) => void = (target, linkPath) =>
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir"),
): { mode: WrapperMode; changed: boolean } {
  const linkPath = dirname(path);
  const target = pkgPath === undefined ? undefined : dirname(pkgPath);

  // Every supported agent discovers the same directory-level skill link.
  if (scope === "user" && target !== undefined) {
    const info = lstatSync(linkPath, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) {
      try {
        if (realpathSync(linkPath) === realpathSync(target)) {
          return { mode: "symlink", changed: false };
        }
      } catch {
        // A dangling link (target gone) cannot be compared; fall through to recreate it.
      }
    }
    try {
      mkdirSync(dirname(linkPath), { recursive: true });
      rmSync(linkPath, { recursive: true, force: true });
      symlink(target, linkPath);
      return { mode: "symlink", changed: true };
    } catch {
      // Symlinks are unsupported on this filesystem/privilege level; copy instead.
      rmSync(linkPath, { recursive: true, force: true });
    }
  }

  // Copy branch: project scope, no packaged path, or the symlink above threw.
  const content = skillContent(skill);
  const info = lstatSync(path, { throwIfNoEntry: false });
  const skillDirInfo = lstatSync(dirname(path), { throwIfNoEntry: false });
  if (
    !skillDirInfo?.isSymbolicLink() &&
    info?.isFile() &&
    !info.isSymbolicLink() &&
    readFileSync(path, "utf8") === content
  ) {
    return { mode: "copy", changed: false };
  }
  rmSync(dirname(path), { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { mode: "copy", changed: true };
}

/** Injectable seams for `refreshInstalledWrappers` (the repo's DI idiom keeps it testable). */
export interface RefreshDeps {
  /** Whether this CLI runs from a source checkout; default `isSourceRun`. */
  sourceRun?: () => boolean;
  /** The packaged `SKILL.md` path a user symlink points at; default `packagedSkillPath()`. */
  pkgPath?: string | undefined;
  /** Optional packaged paths per skill; absent entries use normal resolution. */
  pkgPaths?: Partial<Record<OtaconSkillName, string | undefined>>;
  /** Where to look for a project-scope repo root; default `process.cwd()`. */
  cwd?: string;
}

/**
 * The fallback/migration mechanism: on every `otacon start`, re-assert each
 * ALREADY-INSTALLED managed wrapper to its desired state (`ensureSkill`), so an
 * install done before the symlink era (or one that could not symlink at all)
 * heals itself the next time the tool runs.
 *
 * For a correct symlink this is entirely INERT: `ensureSkill` no-ops a link that
 * already resolves to the packaged directory, so symlink installs (the common case) cost
 * nothing and emit no notice. It only does work on real drift:
 * - a user-scope COPY left by a copy-fallback install (Windows/npx) is promoted to a
 *   symlink to the packaged directory (so future binary upgrades refresh it for free);
 * - a dangling or wrong-target user symlink is repaired;
 * - a committed/legacy PROJECT-scope copy whose text drifted is rewritten to the
 *   current `skillMd()` (still a copy, never a machine-local symlink).
 *
 * It NEVER creates a wrapper that does not already exist: this is a heal-what's-there
 * pass, not an installer. A path absent on disk is skipped, and a regular file is
 * touched only when it carries `MANAGED_MARKER` (so a foreign SKILL.md a user wrote by
 * hand is never clobbered); a symlink at one of our locations is always ours to repair.
 *
 * Skipped wholesale on a SOURCE run: this checkout's committed `otacon-dev` dogfood
 * wrapper is generated and guarded by a test, so a source-mode `start` must never
 * rewrite it (`sourceRun()` true returns `[]` before touching anything).
 *
 * Fail-open throughout: each wrapper is converged inside its own try/catch so one
 * failure cannot abort the rest, and the function itself never throws (a refresh is
 * best-effort and must never block `start`).
 */
export function refreshInstalledWrappers(
  deps: RefreshDeps = {},
): { path: string; mode: WrapperMode }[] {
  const refreshed: { path: string; mode: WrapperMode }[] = [];
  try {
    const sourceRun = deps.sourceRun ?? isSourceRun;
    // Never touch a source checkout's committed dogfood wrapper.
    if (sourceRun()) return [];

    const cwd = deps.cwd ?? process.cwd();

    // The candidate locations to heal: the three user-scope wrappers always, plus the
    // three project-scope wrappers when cwd sits inside a git repo. Presence is decided
    // per-candidate below, so listing one here never implies it exists on disk.
    const candidates: { skill: OtaconSkillName; path: string; scope: "user" | "project" }[] = [];
    for (const skill of OTACON_SKILLS) {
      candidates.push(
        { skill, path: claudeSkillPath(undefined, skill), scope: "user" },
        { skill, path: codexSkillPath(undefined, skill), scope: "user" },
        { skill, path: opencodeSkillPath(undefined, skill), scope: "user" },
      );
    }
    const root = findRepoRoot(cwd);
    if (root !== undefined) {
      const project = { kind: "project", root } as const;
      for (const skill of OTACON_SKILLS) {
        candidates.push(
          { skill, path: claudeSkillPath(project, skill), scope: "project" },
          { skill, path: codexSkillPath(project, skill), scope: "project" },
          { skill, path: opencodeSkillPath(project, skill), scope: "project" },
        );
      }
    }

    for (const { skill, path, scope } of candidates) {
      if (!isManagedWrapper(path)) continue; // only heal what is already installed
      try {
        const injected = deps.pkgPaths !== undefined && skill in deps.pkgPaths
          ? deps.pkgPaths[skill]
          : skill === "otacon" && "pkgPath" in deps
            ? deps.pkgPath
            : packagedSkillPath(skill);
        const result = ensureNamedSkill(skill, path, scope, injected);
        if (result.changed) {
          notice(`refreshed ${skill} skill at ${path} (${result.mode})`);
          refreshed.push({ path, mode: result.mode });
        }
      } catch {
        // Best-effort: a single wrapper's failure must not abort the rest, and the
        // whole pass is fail-open, never blocking start on a refresh.
      }
    }
  } catch {
    // Belt-and-suspenders: the candidate-list setup (cwd lookup, repo-root probe)
    // is unlikely to throw, but the whole pass must never throw out of start.
  }
  return refreshed;
}

/**
 * Whether `path` already holds an otacon-owned wrapper this pass may re-assert.
 * A SYMLINK at one of our skill locations is ours (created by a prior symlink
 * install), so it counts even when the link dangles (`ensureSkill` repairs it).
 * A regular FILE counts only when it carries `MANAGED_MARKER`, so a foreign SKILL.md
 * a user wrote by hand is left alone. Anything else (no entry, a dir) is not present.
 * `lstatSync` inspects the link itself (a symlink is never read as a file), and
 * `{ throwIfNoEntry: false }` turns a missing path into `undefined`, never a throw.
 */
function isManagedWrapper(path: string): boolean {
  const skillDirInfo = lstatSync(dirname(path), { throwIfNoEntry: false });
  if (skillDirInfo?.isSymbolicLink()) return true;
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info === undefined) return false;
  if (info.isSymbolicLink()) return true;
  if (!info.isFile()) return false;
  try {
    return readFileSync(path, "utf8").includes(MANAGED_MARKER);
  } catch {
    return false;
  }
}
