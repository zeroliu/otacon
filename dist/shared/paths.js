import { homedir } from "node:os";
import { join } from "node:path";
// OTACON_HOME and OTACON_PORT exist for hermetic tests and as a port-conflict
// escape hatch (DECISIONS.md "Env overrides"). Read at call time, not import
// time, so tests can set them per-case.
export function otaconHome() {
    return process.env.OTACON_HOME ?? join(homedir(), ".otacon");
}
export function otaconPort() {
    const n = Number(process.env.OTACON_PORT);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : 4747;
}
export function registryPath() {
    return join(otaconHome(), "registry.json");
}
export function daemonLogPath() {
    return join(otaconHome(), "daemon.log");
}
export function globalConfigPath() {
    return join(otaconHome(), "config.json");
}
export function repoConfigPath(repoRoot) {
    return join(repoRoot, "otacon.config.json");
}
export function otaconDir(repoRoot) {
    return join(repoRoot, ".otacon");
}
export function currentSessionPath(repoRoot) {
    return join(otaconDir(repoRoot), "current-session");
}
export function sessionDir(repoRoot, id) {
    return join(otaconDir(repoRoot), id);
}
export function planPath(repoRoot, id) {
    return join(sessionDir(repoRoot, id), "plan.md");
}
export function sessionStatePath(repoRoot, id) {
    return join(sessionDir(repoRoot, id), "session.json");
}
export function eventsPath(repoRoot, id) {
    return join(sessionDir(repoRoot, id), "events.json");
}
/** Comment + question threads for the review UI's rail (DESIGN.md §9, §12). */
export function threadsPath(repoRoot, id) {
    return join(sessionDir(repoRoot, id), "threads.json");
}
/** The grill Q&A transcript (DESIGN.md §8) — appended to the approved artifact. */
export function transcriptPath(repoRoot, id) {
    return join(sessionDir(repoRoot, id), "transcript.json");
}
/** Where approved plan artifacts land (DESIGN.md §12). */
export function plansDir(repoRoot) {
    return join(repoRoot, "docs", "plans");
}
export function revisionPath(repoRoot, id, n) {
    return join(sessionDir(repoRoot, id), `r${n}.md`);
}
/** Lint warnings recorded when r<n>.md was accepted (the UI's L6 badges). */
export function revisionWarningsPath(repoRoot, id, n) {
    return join(sessionDir(repoRoot, id), `r${n}.warnings.json`);
}
/** The agent's changelog submitted with r<n>.md (DESIGN.md §9 layer 1). */
export function revisionChangelogPath(repoRoot, id, n) {
    return join(sessionDir(repoRoot, id), `r${n}.changelog.md`);
}
//# sourceMappingURL=paths.js.map