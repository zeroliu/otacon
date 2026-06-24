// otacon update [--check] — the manual/forced upgrade command (review loop and daemon API,
// install/update). It deliberately bypasses the auto-update gate's two suppressors: it
// ignores the 1h throttle (the user asked NOW) and `update.auto:false` (an
// explicit command overrides a config that only governs the implicit start-time
// check). It still fails open on a registry blip and never escalates to sudo —
// it shares `runNpmUpdate` with the start-time gate, so the install behavior is
// identical (D12, plan docs/plans/2026-06-19-auto-update-outdated-version.md). The
// channel (latest vs staging) is derived from the installed version the same way
// the start-time gate derives it (`channelOf`), so a staging install upgrades on
// staging and a clean install resolves `otacon@latest` exactly as before.
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
import { channelOf, fetchDistTag, isNewer, runNpmUpdate } from "../update.js";

/**
 * Seams so the command is testable with no real registry, npm, or source-run
 * probe. Defaults wire the real implementations; a test passes stubs. Mirrors
 * the `AutoUpdateDeps` shape used by `maybeAutoUpdate`. `fetch` receives the
 * channel dist-tag to look up.
 */
export interface UpdateCommandDeps {
  fetch: typeof fetchDistTag;
  runNpmUpdate: typeof runNpmUpdate;
  sourceRun: () => boolean;
  // The installed version this command reports/compares against. Defaults to the
  // module `VERSION`; tests inject a fixed value because a staging release builds
  // against a `-staging.` VERSION (which would flip the derived channel).
  installedVersion: string;
}

const REAL_DEPS: UpdateCommandDeps = {
  fetch: fetchDistTag,
  runNpmUpdate,
  sourceRun: isSourceRun,
  installedVersion: VERSION,
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
    printJson({ ok: true, source: true, version: deps.installedVersion });
    return 0;
  }

  // Channel (derived from the installed version): a `-staging.` build tracks the
  // `staging` dist-tag, anything else `latest`, the same derivation as the start-time gate.
  const channel = channelOf(deps.installedVersion);

  // Fail-open (D5): a transient registry blip is not a hard error — report that
  // we couldn't check and exit 0, exactly as the start-time gate proceeds.
  const latest = await deps.fetch(channel);
  if (latest === undefined) {
    notice("could not reach the npm registry to check for updates; try again later");
    printJson({ ok: true, current: deps.installedVersion, latest: null, outdated: false });
    return 0;
  }

  const outdated = isNewer(latest, deps.installedVersion);

  // --check never installs: it's the dry run.
  if (values.check === true) {
    printJson({ ok: true, current: deps.installedVersion, latest, outdated });
    return 0;
  }

  // Already current: nothing to do.
  if (!outdated) {
    printJson({ ok: true, current: deps.installedVersion, latest, outdated: false, updated: false });
    return 0;
  }

  // Outdated: install the channel dist-tag. On failure this is the one expected exit-1 path.
  if (!deps.runNpmUpdate(channel).ok) {
    notice(`auto-update failed; run: npm install -g otacon@${channel}`);
    printJson({
      ok: false,
      error: { code: "E_UPDATE_FAILED", message: `npm install -g otacon@${channel} failed` },
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
    `updated otacon ${deps.installedVersion} → ${latest}; the daemon and any open tabs update on your next otacon command`,
  );
  printJson({ ok: true, updated: true, from: deps.installedVersion, to: latest });
  return 0;
}
