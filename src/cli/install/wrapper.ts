// Resolves the in-package SKILL.md asset that the installed wrapper symlinks to.
// `otacon install` copies the wrapper text today, so it goes stale when the binary
// auto-updates; the fix is to SYMLINK the installed wrapper to a real file shipped
// inside the npm package (`dist/skills/otacon/SKILL.md`, generated from `skillMd()`
// by scripts/gen-skill-asset.ts), so a binary upgrade refreshes the skill for free.
// A symlink target must be a STABLE on-disk path, so only the packaged file qualifies;
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
import { skillMd } from "./assets.js";

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
export function packagedSkillPath(): string | undefined {
  try {
    const path = fileURLToPath(
      new URL("../../skills/otacon/SKILL.md", import.meta.url),
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
 * User-scope wrappers SYMLINK to the packaged `SKILL.md` so a binary upgrade
 * refreshes the protocol text for free (the file the symlink points at is the one
 * the new build emits). Two cases fall back to a COPY of `skillMd()` instead:
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
export function ensureWrapper(
  path: string,
  scope: "user" | "project",
  pkgPath: string | undefined = packagedSkillPath(),
  // testability seam: inject a throwing linker to exercise the copy fallback
  symlink: (target: string, linkPath: string) => void = (t, l) => symlinkSync(t, l),
): { mode: WrapperMode; changed: boolean } {
  mkdirSync(dirname(path), { recursive: true });

  // Symlink branch: user scope only, and only when there is a stable file to point at.
  if (scope === "user" && pkgPath !== undefined) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) {
      // realpathSync resolves both sides so a correct link (even via a differently
      // spelled but equivalent path) reads as a no-op.
      try {
        if (realpathSync(path) === realpathSync(pkgPath)) {
          return { mode: "symlink", changed: false };
        }
      } catch {
        // A dangling link (target gone) cannot be compared; fall through to recreate it.
      }
    }
    try {
      rmSync(path, { force: true }); // clear a stale link, an old copy, or a dangling link
      symlink(pkgPath, path);
      return { mode: "symlink", changed: true };
    } catch {
      // Symlinks are unsupported on this filesystem/privilege level; copy instead.
    }
  }

  // Copy branch: project scope, no packaged path, or the symlink above threw.
  const content = skillMd();
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info?.isFile() && readFileSync(path, "utf8") === content) {
    return { mode: "copy", changed: false };
  }
  rmSync(path, { force: true }); // clear a stale symlink or an out-of-date copy
  writeFileSync(path, content);
  return { mode: "copy", changed: true };
}
