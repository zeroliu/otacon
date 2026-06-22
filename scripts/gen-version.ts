#!/usr/bin/env bun
/**
 * Regenerates `src/shared/version.ts` from the authoritative `version` field in
 * `package.json` — single-source versioning. `package.json` is the only file to
 * bump; `npm version` fires the `version` lifecycle hook (see package.json) which
 * runs this and stages the regenerated mirror. Same generated-file pattern as the
 * dogfood `.claude/skills/otacon-dev/SKILL.md`.
 *
 * Run with: `bun run scripts/gen-version.ts` (or `bun run gen:version`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve repo-root package.json relative to this script (scripts/ -> repo root),
// independent of the cwd the generator is invoked from.
const pkgUrl = new URL("../package.json", import.meta.url);
const versionPath = fileURLToPath(
  new URL("../src/shared/version.ts", import.meta.url),
);

const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  throw new Error("package.json is missing a non-empty `version` field");
}

const contents = `// Generated from package.json by scripts/gen-version.ts — do NOT hand-edit.
// version.test.ts guards that this equals package.json's version. Bump the
// version in package.json, then run \`bun run gen:version\` to regenerate.
export const VERSION = ${JSON.stringify(pkg.version)};
`;

writeFileSync(versionPath, contents);
console.log(`Wrote ${versionPath} with VERSION ${pkg.version}`);
