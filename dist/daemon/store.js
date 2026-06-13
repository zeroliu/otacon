// Global session registry, per-session daemon state, and revision snapshots
// (DESIGN.md §7, §12). All state is plain JSON written atomically — temp file +
// rename — so a crash can never leave a half-written file (DECISIONS.md
// "Storage: plain JSON files, not SQLite"). A file that is corrupt anyway
// (manual edit, disk fault) is quarantined, never fatal: it is renamed aside
// and the daemon continues with a fresh structure (DECISIONS.md "Corrupt state
// files are quarantined, not fatal") — a permanently wedged daemon is worse
// than one recoverable file.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as paths from "../shared/paths.js";
let tmpSerial = 0;
let quarantineSerial = 0;
/** Atomic write: temp file in the destination directory (created if needed) + rename. */
export function writeFileAtomic(path, data) {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.tmp-${process.pid}-${tmpSerial++}`);
    writeFileSync(tmp, data);
    renameSync(tmp, path);
}
/** Canonical on-disk JSON formatting for all otacon state files. */
export function stringify(value) {
    return JSON.stringify(value, null, 2) + "\n";
}
/**
 * Move a corrupt state file aside to `<name>.corrupt-<timestamp>` (atomic
 * rename), log to stderr, and let the caller continue with a fresh structure.
 * The serial suffix keeps two quarantines in the same millisecond from
 * overwriting each other.
 */
export function quarantineCorruptFile(path, what) {
    const aside = `${path}.corrupt-${Date.now()}-${quarantineSerial++}`;
    try {
        renameSync(path, aside);
    }
    catch (error) {
        // The file vanished (deleted out from under us mid-recovery) or the rename
        // itself failed. Quarantine exists to keep the daemon alive — moving the
        // evidence aside must never become the new fatal path; the caller's fresh
        // rebuild overwrites whatever is (or is not) left at `path`.
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`otacond: ${what} at ${path} is corrupt and could not be moved aside (${message}); continuing with fresh state\n`);
        return aside;
    }
    process.stderr.write(`otacond: ${what} at ${path} is corrupt; moved it to ${aside} and continuing with fresh state\n`);
    return aside;
}
export function readJsonOr(path) {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return undefined; // unreadable or not JSON — caller quarantines
    }
}
function parseRegistry(raw) {
    const file = raw;
    const valid = typeof file === "object" &&
        file !== null &&
        file.version === 1 &&
        typeof file.sessions === "object" &&
        file.sessions !== null;
    return valid ? file : undefined;
}
function parseState(raw) {
    const file = raw;
    const counters = file?.counters;
    const valid = typeof file === "object" &&
        file !== null &&
        typeof file.id === "string" &&
        typeof file.revision === "number" &&
        typeof counters === "object" &&
        counters !== null &&
        typeof counters.batch === "number" &&
        typeof counters.thread === "number" &&
        typeof counters.question === "number" &&
        typeof counters.eventSeq === "number";
    if (!valid)
        return undefined;
    // Pre-M3 state files lack the field; a hand-edited/restored file may carry a
    // non-integer or a value beyond the current revision, which would poison the
    // diff endpoint's default baseline (400 on a parameterless GET, or a 500 via
    // readRevision(1.5)). Defaulting/clamping beats quarantining either way.
    const reviewed = file.lastReviewedRevision;
    file.lastReviewedRevision =
        typeof reviewed === "number" && Number.isInteger(reviewed) && reviewed > 0
            ? Math.min(reviewed, file.revision)
            : 0;
    return file;
}
/** Highest r<N>.md snapshot on disk — the revision counter's source of truth. */
function recoverRevision(repo, id) {
    let max = 0;
    try {
        for (const name of readdirSync(paths.sessionDir(repo, id))) {
            const match = /^r(\d+)\.md$/.exec(name);
            if (match)
                max = Math.max(max, Number(match[1]));
        }
    }
    catch {
        // no session dir yet — revision 0
    }
    return max;
}
/**
 * High-water scan of threads.json and events.json so rebuilt counters never
 * re-mint a live id (DECISIONS.md "Quarantine counter recovery") — duplicate
 * thread ids would cross-wire resolutions now that threads carry state. Reads
 * loosely (no thread validation): a half-corrupt file should still surrender
 * every id it can.
 */
function recoverCounters(repo, id) {
    const counters = { batch: 0, thread: 0, question: 0, eventSeq: 0 };
    const see = (key, raw, re) => {
        const match = typeof raw === "string" ? re.exec(raw) : null;
        if (match)
            counters[key] = Math.max(counters[key], Number(match[1]));
    };
    const threadsRaw = readJsonOr(paths.threadsPath(repo, id));
    for (const t of Array.isArray(threadsRaw?.threads) ? threadsRaw.threads : []) {
        const thread = t;
        see("thread", thread?.id, /^t(\d+)$/);
        see("question", thread?.id, /^q(\d+)$/);
        see("batch", thread?.batch, /^b(\d+)$/);
    }
    // Agent grill questions share the q counter with user-question threads.
    const transcriptRaw = readJsonOr(paths.transcriptPath(repo, id));
    for (const e of Array.isArray(transcriptRaw?.entries) ? transcriptRaw.entries : []) {
        see("question", e?.id, /^q(\d+)$/);
    }
    const eventsRaw = readJsonOr(paths.eventsPath(repo, id));
    for (const e of Array.isArray(eventsRaw?.events) ? eventsRaw.events : []) {
        const event = e;
        if (typeof event?.seq === "number") {
            counters.eventSeq = Math.max(counters.eventSeq, event.seq);
        }
        see("batch", event?.payload?.batch, /^b(\d+)$/);
        see("question", event?.payload?.id, /^q(\d+)$/);
        for (const item of Array.isArray(event?.payload?.items) ? event.payload.items : []) {
            see("thread", item?.thread, /^t(\d+)$/);
        }
    }
    return counters;
}
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
/**
 * Owns `$OTACON_HOME/registry.json` plus each session's `.otacon/<id>/` state in
 * its repo. Event seqs and the b/t/q stable ids are minted here (bumpCounter)
 * so they survive queue drains and daemon restarts.
 */
export class Store {
    registryFile;
    registry;
    constructor() {
        this.registryFile = paths.registryPath();
        if (!existsSync(this.registryFile)) {
            this.registry = { version: 1, sessions: {} };
            return;
        }
        const parsed = parseRegistry(readJsonOr(this.registryFile));
        if (parsed) {
            this.registry = parsed;
            return;
        }
        // Sessions registered there are forgotten (their .otacon/ dirs survive for
        // manual recovery); the alternative is a daemon that can never boot again.
        quarantineCorruptFile(this.registryFile, "session registry");
        this.registry = { version: 1, sessions: {} };
        this.flushRegistry();
    }
    listSessions() {
        return Object.values(this.registry.sessions).map((s) => ({ ...s }));
    }
    getSession(id) {
        const session = this.registry.sessions[id];
        return session ? { ...session } : undefined;
    }
    createSession(input) {
        const id = this.mintId();
        const now = new Date().toISOString();
        const session = {
            id,
            title: input.title,
            repo: input.repo,
            branch: input.branch ?? "",
            quick: input.quick ?? false,
            status: "draft",
            createdAt: now,
            updatedAt: now,
        };
        // State files first, registry entry last: the registry is the commit point.
        // A crash in between leaves an orphan .otacon/<id>/ dir (harmless), never a
        // registered session whose state files are missing (wedged forever).
        const state = {
            id,
            revision: 0,
            lastReviewedRevision: 0,
            counters: { batch: 0, thread: 0, question: 0, eventSeq: 0 },
        };
        writeFileAtomic(paths.sessionStatePath(input.repo, id), stringify(state));
        writeFileAtomic(paths.eventsPath(input.repo, id), stringify({ version: 1, events: [] }));
        this.registry.sessions[id] = session;
        this.flushRegistry();
        return { ...session };
    }
    updateSession(id, patch) {
        const session = this.require(id);
        Object.assign(session, patch);
        session.updatedAt = new Date().toISOString();
        this.flushRegistry();
        return { ...session };
    }
    /**
     * Remove a session from the registry (otacon clean, DESIGN.md §12); the
     * .otacon/<id>/ dir in its repo is the CLI's to archive afterwards.
     */
    deleteSession(id) {
        const session = this.require(id);
        delete this.registry.sessions[id];
        this.flushRegistry();
        return { ...session };
    }
    readState(id) {
        const session = this.require(id);
        const path = paths.sessionStatePath(session.repo, id);
        if (existsSync(path)) {
            const parsed = parseState(readJsonOr(path));
            if (parsed && parsed.id === id)
                return parsed;
            quarantineCorruptFile(path, `session state for ${id}`);
        }
        // Rebuild: revision comes from the r<N>.md snapshots (they are the actual
        // plan history — restarting at r1 would overwrite them); counters from a
        // high-water scan of threads.json and events.json, so rebuilt counters
        // cannot mint duplicate live ids (DECISIONS.md "Quarantine counter
        // recovery"). lastReviewedRevision restarts at 0 — the diff baseline
        // degrades to "previous revision", which the user can re-select.
        const state = {
            id,
            revision: recoverRevision(session.repo, id),
            lastReviewedRevision: 0,
            counters: recoverCounters(session.repo, id),
        };
        writeFileAtomic(path, stringify(state));
        return state;
    }
    /**
     * Record that the user has reviewed revision n (a comment-batch flush, or
     * the UI's explicit mark-reviewed). Monotonic: the stored value never moves
     * backwards — older baselines stay reachable via the diff endpoint's ?from=.
     */
    markReviewed(id, n) {
        const session = this.require(id);
        const state = this.readState(id);
        if (n > state.lastReviewedRevision) {
            state.lastReviewedRevision = Math.min(n, state.revision);
            writeFileAtomic(paths.sessionStatePath(session.repo, id), stringify(state));
        }
        return state.lastReviewedRevision;
    }
    /** Increment one daemon-owned counter (DESIGN.md §6 stable ids) and persist it. */
    bumpCounter(id, key) {
        return this.bumpCounters(id, { [key]: 1 })[key];
    }
    /**
     * Increment several counters in one read + one atomic write (a comment batch
     * mints N thread ids, a batch id, and an event seq together); returns the
     * updated counter values.
     */
    bumpCounters(id, by) {
        const session = this.require(id);
        const state = this.readState(id);
        for (const key of Object.keys(by)) {
            state.counters[key] += by[key] ?? 0;
        }
        writeFileAtomic(paths.sessionStatePath(session.repo, id), stringify(state));
        return { ...state.counters };
    }
    /**
     * Store the next revision snapshot r<N>.md plus the lint warnings it was
     * accepted with (r<N>.warnings.json — the UI's L6 badges; DESIGN.md §12)
     * and the agent's changelog when one accompanied it (r<N>.changelog.md);
     * returns N.
     */
    saveRevision(id, content, warnings = [], changelog) {
        const session = this.require(id);
        const state = this.readState(id);
        state.revision += 1;
        writeFileAtomic(paths.revisionPath(session.repo, id, state.revision), content);
        writeFileAtomic(paths.revisionWarningsPath(session.repo, id, state.revision), stringify(warnings));
        if (changelog !== undefined && changelog.trim() !== "") {
            writeFileAtomic(paths.revisionChangelogPath(session.repo, id, state.revision), changelog);
        }
        writeFileAtomic(paths.sessionStatePath(session.repo, id), stringify(state));
        session.updatedAt = new Date().toISOString();
        this.flushRegistry();
        return state.revision;
    }
    readRevision(id, n) {
        const session = this.require(id);
        return readFileSync(paths.revisionPath(session.repo, id, n), "utf8");
    }
    /** The changelog submitted with r<n>.md; null when none was (r1, typically). */
    readRevisionChangelog(id, n) {
        const session = this.require(id);
        try {
            return readFileSync(paths.revisionChangelogPath(session.repo, id, n), "utf8");
        }
        catch {
            return null;
        }
    }
    /**
     * Warnings recorded with r<n>.md. Missing or corrupt files read as [] — the
     * badges are presentation metadata, never worth quarantine machinery.
     */
    readRevisionWarnings(id, n) {
        const session = this.require(id);
        const raw = readJsonOr(paths.revisionWarningsPath(session.repo, id, n));
        return Array.isArray(raw) ? raw : [];
    }
    /** Where this session's SessionQueue persists — for the daemon to wire queues. */
    eventsPath(id) {
        return paths.eventsPath(this.require(id).repo, id);
    }
    /** Where this session's review threads persist (src/daemon/threads.ts). */
    threadsPath(id) {
        return paths.threadsPath(this.require(id).repo, id);
    }
    /** Where this session's grill transcript persists (src/daemon/transcript.ts). */
    transcriptPath(id) {
        return paths.transcriptPath(this.require(id).repo, id);
    }
    require(id) {
        const session = this.registry.sessions[id];
        if (!session)
            throw new Error(`unknown session: ${id}`);
        return session;
    }
    /** `otc_` + 6 base36 chars, collision-checked (DECISIONS.md "Session ids"). */
    mintId() {
        for (let attempt = 0; attempt < 64; attempt++) {
            let suffix = "";
            for (const byte of randomBytes(6))
                suffix += BASE36[byte % 36];
            const id = `otc_${suffix}`;
            if (!(id in this.registry.sessions))
                return id;
        }
        throw new Error("could not mint a unique session id");
    }
    flushRegistry() {
        writeFileAtomic(this.registryFile, stringify(this.registry));
    }
}
//# sourceMappingURL=store.js.map