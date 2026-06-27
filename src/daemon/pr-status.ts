// The GitHub PR-state probe: the daemon's poller asks GitHub "is this session's
// latest PR still open, merged, or closed?" so the home UI can section an
// implemented plan by its real fate instead of leaving it a graveyard. It shells
// out to the `gh` CLI (`gh pr view <url> --json state`), reusing the user's
// existing `gh auth` (no token for otacon to store, manage, or leak), and it is a
// LOCAL OS call, never a model API (the zero-API-spend invariant is untouched).
//
// `fetchPrState` is pure and total: it NEVER throws or rejects. On ANY failure
// (gh missing / ENOENT, non-zero exit, network error, a hung process that the
// timeout kills, empty / malformed / unexpected JSON, an unknown state value) it
// resolves `undefined`, which the caller reads as "couldn't determine, treat as
// still open and degrade to a plain link". `gh` reports `state` as one of OPEN /
// CLOSED / MERGED, which we lower-case into the model's "open" / "merged" /
// "closed".

import { execFile } from "node:child_process";

export type PrState = "open" | "merged" | "closed";

/** How long a single `gh pr view` may run before we give up and resolve undefined. */
const GH_TIMEOUT_MS = 5_000;

/**
 * The process seam: `run(args)` invokes `gh` with the given argv and resolves its
 * stdout. Tests inject a fake to simulate success / spawn error / non-zero exit
 * without spawning a real process; the default actually runs `gh`.
 */
export interface PrStatusDeps {
  run?: (args: string[]) => Promise<string>;
}

/** Default seam: `execFile("gh", …)` (arg array, no shell) with a timeout, resolving stdout (rejects on failure). */
const defaultRun = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: GH_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

/**
 * Probe a PR's GitHub state via `gh pr view <url> --json state`. Returns the
 * mapped `PrState`, or `undefined` on any failure whatsoever (see file header).
 * Never throws.
 */
export async function fetchPrState(
  url: string,
  deps: PrStatusDeps = {},
): Promise<PrState | undefined> {
  const run = deps.run ?? defaultRun;
  try {
    const stdout = await run(["pr", "view", url, "--json", "state"]);
    const parsed = JSON.parse(stdout) as { state?: unknown };
    switch (parsed.state) {
      case "OPEN":
        return "open";
      case "MERGED":
        return "merged";
      case "CLOSED":
        return "closed";
      default:
        return undefined; // empty, missing, or an unexpected value
    }
  } catch {
    // gh missing/ENOENT, non-zero exit, network error, timeout kill, or malformed
    // JSON: all degrade to "couldn't determine".
    return undefined;
  }
}
