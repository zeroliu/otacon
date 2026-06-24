// Resolves the in-package SKILL.md asset that the installed wrapper symlinks to.
// `otacon install` copies the wrapper text today, so it goes stale when the binary
// auto-updates; the fix is to SYMLINK the installed wrapper to a real file shipped
// inside the npm package (`dist/skills/otacon/SKILL.md`, generated from `skillMd()`
// by scripts/gen-skill-asset.ts), so a binary upgrade refreshes the skill for free.
// A symlink target must be a STABLE on-disk path, so only the packaged file qualifies;
// when there is no such file (running from source, or an ephemeral npx cache that a
// later invocation may have wiped), callers must fall back to COPYING instead.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
