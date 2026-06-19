// otacon update [--check] — the manual/forced upgrade command (DESIGN.md §6,
// §16). It deliberately bypasses the auto-update gate's two suppressors: it
// ignores the 1h throttle (the user asked NOW) and `update.auto:false` (an
// explicit command overrides a config that only governs the implicit start-time
// check). It still fails open on a registry blip and never escalates to sudo —
// it shares `runNpmUpdate` with the start-time gate, so the install behavior is
// identical (D12, plan docs/plans/2026-06-19-auto-update-outdated-version.md).
//
//   --check  report current/latest/outdated and exit; never installs (a dry run
//            for "am I behind?", and the only safe mode in CI / pinned shops).
//
// stdout is the usual single JSON line; npm's own progress and our notices go to
// stderr. Exit 0 on every reported outcome except an attempted-but-failed
// install, which is the one expected exit-1 failure (the manual command to run
// is on stderr).

import { parseArgs } from "node:util";
import { VERSION } from "../../shared/version.js";
import { isSourceRun } from "../client.js";
import { notice, printJson } from "../output.js";
import { fetchLatest, isNewer, runNpmUpdate } from "../update.js";

/**
 * Seams so the command is testable with no real registry, npm, or source-run
 * probe. Defaults wire the real implementations; a test passes stubs. Mirrors
 * the `AutoUpdateDeps` shape used by `maybeAutoUpdate`.
 */
export interface UpdateCommandDeps {
  fetch: typeof fetchLatest;
  runNpmUpdate: typeof runNpmUpdate;
  sourceRun: () => boolean;
}

const REAL_DEPS: UpdateCommandDeps = {
  fetch: fetchLatest,
  runNpmUpdate,
  sourceRun: isSourceRun,
};

export async function updateCommand(
  argv: string[],
  deps: UpdateCommandDeps = REAL_DEPS,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { check: { type: "boolean", default: false } },
  });

  // Dev-run refusal (D6): a source checkout has no global package to update.
  if (deps.sourceRun()) {
    notice("running otacon from a source checkout; nothing to update");
    printJson({ ok: true, source: true, version: VERSION });
    return 0;
  }

  // Fail-open (D5): a transient registry blip is not a hard error — report that
  // we couldn't check and exit 0, exactly as the start-time gate proceeds.
  const latest = await deps.fetch();
  if (latest === undefined) {
    notice("could not reach the npm registry to check for updates; try again later");
    printJson({ ok: true, current: VERSION, latest: null, outdated: false });
    return 0;
  }

  const outdated = isNewer(latest, VERSION);

  // --check never installs: it's the dry run.
  if (values.check === true) {
    printJson({ ok: true, current: VERSION, latest, outdated });
    return 0;
  }

  // Already current: nothing to do.
  if (!outdated) {
    printJson({ ok: true, current: VERSION, latest, outdated: false, updated: false });
    return 0;
  }

  // Outdated: install. On failure this is the one expected exit-1 path.
  if (!deps.runNpmUpdate(latest).ok) {
    notice("auto-update failed; run: npm install -g otacon@latest");
    printJson({
      ok: false,
      error: { code: "E_UPDATE_FAILED", message: "npm install -g otacon@latest failed" },
    });
    return 1;
  }

  // Success. This process is STILL the old code (the binary was swapped under
  // it), so we do NOT restart the daemon here: ensureDaemon from this old CLI
  // would see daemon.version === this process's (old) VERSION and find no
  // mismatch, so it could not pull the new version anyway. The new daemon (and
  // the open tabs' self-heal) come up on the NEXT `otacon` invocation, which
  // runs the freshly-installed binary and trips the version handshake. We report
  // that accurately rather than claim a restart that didn't happen (D12).
  notice(
    `updated otacon ${VERSION} → ${latest}; the daemon and any open tabs update on your next otacon command`,
  );
  printJson({ ok: true, updated: true, from: VERSION, to: latest });
  return 0;
}
