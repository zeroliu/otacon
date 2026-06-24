import { homedir } from "node:os";
import { join } from "node:path";

// OTACON_HOME and OTACON_PORT exist for hermetic tests and as a port-conflict
// escape hatch (DECISIONS.md "Env overrides"). Read at call time, not import
// time, so tests can set them per-case.

export function otaconHome(): string {
  return process.env.OTACON_HOME ?? join(homedir(), ".otacon");
}

export function otaconPort(): number {
  const n = Number(process.env.OTACON_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 4747;
}

export function registryPath(): string {
  return join(otaconHome(), "registry.json");
}

export function daemonLogPath(): string {
  return join(otaconHome(), "daemon.log");
}

export function globalConfigPath(): string {
  return join(otaconHome(), "config.json");
}

/**
 * The auto-update check cache (`<OTACON_HOME>/update-check.json`): records
 * `checkedAt` so `otacon start` throttles the registry fetch to once per hour
 * instead of paying a round-trip on every start.
 */
export function updateCachePath(): string {
  return join(otaconHome(), "update-check.json");
}

/**
 * The canonical home session root (`<OTACON_HOME>/sessions`): every session's
 * working state lives here keyed by its session id, regardless of the repo, and
 * the approved plan lands here too. Deleting a session (UI or `otacon clean`)
 * removes its `<id>/` folder outright.
 */
export function homeSessionsDir(): string {
  return join(otaconHome(), "sessions");
}

/**
 * One session's home dir (`<OTACON_HOME>/sessions/<id>`). The session id is a
 * globally-unique hash, so this never collides across repos. It is the
 * per-session working dir (state, events, threads, revisions) AND where the
 * approved plan lands as `<date>-<slug>.md`.
 */
export function homeSessionDir(id: string): string {
  return join(homeSessionsDir(), id);
}

/**
 * The team-shared project config (`<repo>/.otacon/config.json`), mirroring
 * Claude Code's `settings.json`. It overrides the global (user) config for this
 * repo and is in turn overridden by the local override below.
 */
export function repoConfigPath(repoRoot: string): string {
  return join(otaconDir(repoRoot), "config.json");
}

/**
 * The personal, per-developer project override
 * (`<repo>/.otacon/config.local.json`), mirroring Claude Code's
 * `settings.local.json`. The Settings UI writes it for a one-off override that
 * wins over both the user and the team project config.
 */
export function repoLocalConfigPath(repoRoot: string): string {
  return join(otaconDir(repoRoot), "config.local.json");
}

/** Expand a leading `~`/`~/` to the OS home dir; leave other paths untouched. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function otaconDir(repoRoot: string): string {
  return join(repoRoot, ".otacon");
}

/**
 * One session's working+archive dir. Lives in the home store
 * (`~/.otacon/sessions/<id>/`), not in the repo: state, events, threads,
 * revisions, and the approved plan all share this id-keyed, repo-independent
 * folder. Equals homeSessionDir(id).
 */
export function sessionDir(id: string): string {
  return homeSessionDir(id);
}

/** The draft plan markdown (home store `~/.otacon/sessions/<id>/plan.md`). */
export function planPath(id: string): string {
  return join(sessionDir(id), "plan.md");
}

/** The session state file (home store `~/.otacon/sessions/<id>/session.json`). */
export function sessionStatePath(id: string): string {
  return join(sessionDir(id), "session.json");
}

/** The persisted event queue (home store `~/.otacon/sessions/<id>/events.json`). */
export function eventsPath(id: string): string {
  return join(sessionDir(id), "events.json");
}

/** Comment + question threads for the review UI's rail, in the home store `~/.otacon/sessions/<id>/threads.json` (threaded review and revision, approval and archive lifecycle). */
export function threadsPath(id: string): string {
  return join(sessionDir(id), "threads.json");
}

/** The grill Q&A transcript (interview questions), in the home store `~/.otacon/sessions/<id>/transcript.json`: appended to the approved artifact. */
export function transcriptPath(id: string): string {
  return join(sessionDir(id), "transcript.json");
}

/** The append-only live-activity feed (`otacon progress` notes), in the home store `~/.otacon/sessions/<id>/activity.json`. */
export function activityPath(id: string): string {
  return join(sessionDir(id), "activity.json");
}

/**
 * The append-only normalized live-activity stream (JSONL), in the home store
 * `~/.otacon/sessions/<id>/stream.jsonl`: captured agent activity plus `otacon
 * progress` highlights. Ephemeral, capped, one event per line, distinct from
 * the legacy `activity.json` (the draft-chip feed).
 */
export function streamPath(id: string): string {
  return join(sessionDir(id), "stream.jsonl");
}

/** A revision snapshot (home store `~/.otacon/sessions/<id>/r<n>.md`). */
export function revisionPath(id: string, n: number): string {
  return join(sessionDir(id), `r${n}.md`);
}

/** Lint warnings recorded when r<n>.md was accepted (the UI's L6 badges), in the home store `~/.otacon/sessions/<id>/r<n>.warnings.json`. */
export function revisionWarningsPath(id: string, n: number): string {
  return join(sessionDir(id), `r${n}.warnings.json`);
}

/** The agent's changelog submitted with r<n>.md, in the home store `~/.otacon/sessions/<id>/r<n>.changelog.md` (threaded review and revision layer 1). */
export function revisionChangelogPath(id: string, n: number): string {
  return join(sessionDir(id), `r${n}.changelog.md`);
}
