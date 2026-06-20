// Tracks which sessions have a *visible* review open, so a desktop banner is
// suppressed only while the user is actually looking (review loop and daemon API, review UI). The
// UI reports `document.visibilityState` over POST /api/sessions/:id/presence —
// {visible:true} when the review becomes visible and on a heartbeat while it
// stays visible, {visible:false} on visibilitychange→hidden and on unload.
//
// Suppression keys on visibility, NOT a live SSE connection: a hidden or
// backgrounded tab keeps its stream open, so a connection count would wrongly
// silence banners when the user can't see the page. A TTL makes a crashed or
// closed visible tab self-expire (it stops sending heartbeats), while an
// explicit hidden ping un-suppresses immediately.

/** A visible tab is "watched" for this long after its last heartbeat, then expires. */
const WATCH_TTL_MS = 45_000;

export class Presence {
  private readonly lastVisibleAt = new Map<string, number>();

  /** `now`/`ttlMs` are injectable so tests drive expiry without real time. */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = WATCH_TTL_MS,
  ) {}

  /** The session's review just became (or stays) visible — refresh its heartbeat. */
  markVisible(id: string): void {
    this.lastVisibleAt.set(id, this.now());
  }

  /** An explicit "no longer visible" ping (blur/unload) — un-suppress immediately. */
  markHidden(id: string): void {
    this.lastVisibleAt.delete(id);
  }

  /** True while a visible tab's heartbeat is fresh; a crashed/closed tab self-expires. */
  isWatched(id: string): boolean {
    const at = this.lastVisibleAt.get(id);
    return at !== undefined && this.now() - at < this.ttlMs;
  }
}
