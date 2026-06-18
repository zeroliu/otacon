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
 * The auto-update check cache (`<OTACON_HOME>/update-check.json`, DESIGN.md
 * §16): records `checkedAt` so `otacon start` throttles the registry fetch to
 * once per hour instead of paying a round-trip on every start.
 */
export function updateCachePath(): string {
  return join(otaconHome(), "update-check.json");
}

/**
 * The canonical home plan archive root (`<OTACON_HOME>/sessions`, DESIGN.md
 * §12): every approved plan lands here keyed by its session id, regardless of
 * the repo. This store is permanent — `otacon clean` never touches it — so a
 * plan is always recoverable even after its repo working state is archived.
 */
export function homeSessionsDir(): string {
  return join(otaconHome(), "sessions");
}

/**
 * One session's home archive dir (`<OTACON_HOME>/sessions/<id>`). The session
 * id is a globally-unique hash, so this never collides across repos — mirroring
 * the repo-local `.otacon/<id>/` layout. The approved plan lands here as
 * `<date>-<slug>.md`.
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

export function otaconDir(repoRoot: string): string {
  return join(repoRoot, ".otacon");
}

export function sessionDir(repoRoot: string, id: string): string {
  return join(otaconDir(repoRoot), id);
}

export function planPath(repoRoot: string, id: string): string {
  return join(sessionDir(repoRoot, id), "plan.md");
}

export function sessionStatePath(repoRoot: string, id: string): string {
  return join(sessionDir(repoRoot, id), "session.json");
}

export function eventsPath(repoRoot: string, id: string): string {
  return join(sessionDir(repoRoot, id), "events.json");
}

/** Comment + question threads for the review UI's rail (DESIGN.md §9, §12). */
export function threadsPath(repoRoot: string, id: string): string {
  return join(sessionDir(repoRoot, id), "threads.json");
}

/** The grill Q&A transcript (DESIGN.md §8) — appended to the approved artifact. */
export function transcriptPath(repoRoot: string, id: string): string {
  return join(sessionDir(repoRoot, id), "transcript.json");
}

/** The append-only live-activity feed (DESIGN.md §6, §12) — `otacon progress` notes. */
export function activityPath(repoRoot: string, id: string): string {
  return join(sessionDir(repoRoot, id), "activity.json");
}

export function revisionPath(repoRoot: string, id: string, n: number): string {
  return join(sessionDir(repoRoot, id), `r${n}.md`);
}

/** Lint warnings recorded when r<n>.md was accepted (the UI's L6 badges). */
export function revisionWarningsPath(repoRoot: string, id: string, n: number): string {
  return join(sessionDir(repoRoot, id), `r${n}.warnings.json`);
}

/** The agent's changelog submitted with r<n>.md (DESIGN.md §9 layer 1). */
export function revisionChangelogPath(repoRoot: string, id: string, n: number): string {
  return join(sessionDir(repoRoot, id), `r${n}.changelog.md`);
}
