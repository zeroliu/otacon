// otacon config [open] | config get <key> (DESIGN.md §6, §16).
//
//   otacon config            — print the Settings web UI URL. Inside a git repo
//     it carries `?repo=<repo root>` so the screen defaults to Project scope for
//     this repo; outside any repo it is the bare `/settings` (User scope). Like
//     `otacon open`, it prints the URL and never launches a browser (DECISIONS.md
//     "open prints, never launches a browser") — the user opens it.
//   otacon config get <key>  — read-only: resolve the merged effective value of
//     one dotted key (`worktree.dir`, `budgets.summaryLines`, …) from the config
//     files via loadConfig and print it. No daemon: it reads config directly so
//     the agent implement loop can consume `worktree.dir` (DECISIONS.md
//     "read-only `config get`"). Editing config stays UI-only.

import { CONFIG_SCHEMA, loadConfig, type OtaconConfig } from "../../shared/config.js";
import { baseUrl, ensureDaemon } from "../client.js";
import { fail, printJson, usageError } from "../output.js";
import { findRepoRoot, realpathOr } from "../session.js";

/** Every valid dotted key, derived from the one schema source of truth. */
const KNOWN_KEYS = new Set(CONFIG_SCHEMA.map((field) => `${field.section}.${field.key}`));

export async function configCommand(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === "get") return configGet(argv.slice(1));
  // No sub-form, or the explicit `open` verb: open the Settings web UI.
  if (sub === undefined || sub === "open") return configOpen();
  usageError("usage: otacon config [open] | otacon config get <key>");
}

/** Print the Settings web UI URL (mirrors `otacon open`: print, never launch). */
async function configOpen(): Promise<number> {
  await ensureDaemon();
  // Inside a git repo, default the Settings screen to this repo's Project scope
  // via ?repo=; outside any repo there is no project target, so open User scope.
  const repoRoot = findRepoRoot(realpathOr(process.cwd()));
  const url =
    repoRoot === undefined
      ? `${baseUrl()}/settings`
      : `${baseUrl()}/settings?repo=${encodeURIComponent(repoRoot)}`;
  printJson({ ok: true, url, ...(repoRoot === undefined ? {} : { repo: repoRoot }) });
  return 0;
}

/** Read-only merged lookup of one dotted config key. */
function configGet(args: string[]): number {
  const key = args[0];
  if (key === undefined || args.length > 1) {
    usageError("otacon config get takes exactly one <key> (e.g. worktree.dir)");
  }
  if (!KNOWN_KEYS.has(key)) {
    fail(
      "E_UNKNOWN_KEY",
      `unknown config key ${key}; valid keys: ${[...KNOWN_KEYS].join(", ")}`,
    );
  }
  // Resolve against the cwd repo's merged config when inside a repo, else the
  // defaults←user layers alone — exactly what the runtime would see here.
  const repoRoot = findRepoRoot(realpathOr(process.cwd()));
  const config = loadConfig(repoRoot);
  const [section, leaf] = key.split(".") as [keyof OtaconConfig, string];
  // `key` passed the CONFIG_SCHEMA check above, so section/leaf name a real
  // config field; the unknown hop is the schema-driven section→leaf indexing
  // (same shape overlayConfig uses) rather than a per-section union.
  const value = (config[section] as unknown as Record<string, unknown>)[leaf];
  printJson({ ok: true, key, value });
  return 0;
}
