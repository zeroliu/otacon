// One in-memory liveness tracker of connected browser tabs (any session or the
// index), fed by an explicit heartbeat from the SPA rather than SSE-connection
// detection: the dogfood daemon runs under Bun, whose node:http emulation does
// not fire a request's abort signal on client disconnect, so a connection count
// would leak upward forever. A TTL makes a closed/crashed tab self-expire, and a
// `gone` beacon on tab close drops it immediately. Drives `otacon open`'s
// duplicate-tab dedup (DECISIONS.md "reuse an existing open tab").

/** A tab counts as live for this long after its last heartbeat, then expires. */
const VIEWER_TTL_MS = 90_000;

export class Viewers {
  private readonly lastSeen = new Map<string, number>();

  /** `now`/`ttlMs` are injectable so tests drive expiry without real time. */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = VIEWER_TTL_MS,
  ) {}

  /** A tab pinged: record its lastSeen so it counts for another TTL window. */
  beat(clientId: string): void {
    this.lastSeen.set(clientId, this.now());
  }

  /** A tab's `gone` beacon (clean close): drop it immediately, no TTL wait. */
  drop(clientId: string): void {
    this.lastSeen.delete(clientId);
  }

  /** Live clients = entries seen within the TTL; prunes the stale ones lazily. */
  count(): number {
    const cutoff = this.now() - this.ttlMs;
    for (const [clientId, at] of this.lastSeen) {
      if (at <= cutoff) this.lastSeen.delete(clientId);
    }
    return this.lastSeen.size;
  }
}
