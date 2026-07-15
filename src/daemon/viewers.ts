// One in-memory liveness tracker of connected browser tabs (any session or the
// index), fed by an explicit heartbeat from the SPA rather than SSE-connection
// detection: the dogfood daemon runs under Bun, whose node:http emulation does
// not fire a request's abort signal on client disconnect, so a connection count
// would leak upward forever. A TTL makes a closed/crashed tab self-expire, and a
// `gone` beacon on tab close drops it immediately. Drives `otacon open`'s
// exact-tab reuse (DECISIONS.md "routes one existing tab").

/** A tab counts as live for this long after its last heartbeat, then expires. */
const VIEWER_TTL_MS = 90_000;

export class Viewers {
  private readonly clients = new Map<string, { lastSeen: number; visible: boolean; sequence: number }>();
  private sequence = 0;

  /** `now`/`ttlMs` are injectable so tests drive expiry without real time. */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = VIEWER_TTL_MS,
  ) {}

  /** A tab pinged: record its lastSeen so it counts for another TTL window. */
  beat(clientId: string, visible?: boolean): void {
    const prior = this.clients.get(clientId);
    this.clients.set(clientId, {
      lastSeen: this.now(),
      visible: visible ?? prior?.visible ?? false,
      sequence: ++this.sequence,
    });
  }

  /** A tab's `gone` beacon (clean close): drop it immediately, no TTL wait. */
  drop(clientId: string): void {
    this.clients.delete(clientId);
  }

  /** Remove clients whose heartbeat TTL elapsed. */
  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [clientId, client] of this.clients) {
      if (client.lastSeen <= cutoff) this.clients.delete(clientId);
    }
  }

  /** Live clients = entries seen within the TTL; prunes the stale ones lazily. */
  count(): number {
    this.prune();
    return this.clients.size;
  }

  /**
   * Pick exactly one existing Otacon tab for `otacon open`: the freshest
   * visible tab wins, falling back to the freshest live background tab. The
   * monotonic sequence breaks same-millisecond heartbeat ties deterministically.
   */
  preferred(): string | undefined {
    this.prune();
    let selected: { id: string; visible: boolean; sequence: number } | undefined;
    for (const [id, client] of this.clients) {
      if (
        selected === undefined ||
        Number(client.visible) > Number(selected.visible) ||
        (client.visible === selected.visible && client.sequence > selected.sequence)
      ) {
        selected = { id, visible: client.visible, sequence: client.sequence };
      }
    }
    return selected?.id;
  }
}
