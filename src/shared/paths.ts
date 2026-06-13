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

export function repoConfigPath(repoRoot: string): string {
  return join(repoRoot, "otacon.config.json");
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

/** Where approved plan artifacts land (DESIGN.md §12). */
export function plansDir(repoRoot: string): string {
  return join(repoRoot, "docs", "plans");
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
