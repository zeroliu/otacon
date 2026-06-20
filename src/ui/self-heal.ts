// Open-tab self-heal after a daemon update (install/update). `otacon start` can
// auto-update and re-exec, which restarts otacond on a newer version — but an
// already-open review tab keeps running the old in-memory bundle, whose hashed
// lazy chunks (the plan renderer + mermaid) 404 against the rebuilt dist/ui and
// wedge the page. The daemon now stamps its VERSION onto every SSE snapshot
// (ui.ts), so a tab re-learns it on each (re)connect; when that differs from the
// version baked into this bundle (__OTACON_VERSION__, vite.config.ts) we reload
// once to fetch the fresh code. index.html is served no-cache and the hashed
// assets are immutable, so the reload genuinely pulls the new build.

// One reload per target version: a version that can't converge (the daemon
// updated but the CLI/bundle is pinned, or vice versa) must never loop. The
// guard is keyed to the TARGET (the daemon's) version and set BEFORE reloading,
// so even if the reload lands on the same stale bundle the second snapshot is a
// no-op. sessionStorage scopes it to this tab and clears on close — a genuinely
// fresh restart in a new tab still heals.
const GUARD_KEY = "otacon-reloaded-for";

/**
 * Reload this tab once if the daemon is running a different version than the
 * bundle. No-ops on a matching/empty/non-string version, outside a browser, or
 * if this tab already reloaded for this target version.
 */
export function maybeSelfHeal(daemonVersion: string | undefined): void {
  if (typeof daemonVersion !== "string" || daemonVersion === "") return;
  // SSR/test-safe: bail unless a real browser environment is present.
  if (typeof window === "undefined" || typeof sessionStorage === "undefined") return;
  if (daemonVersion === __OTACON_VERSION__) return;
  try {
    // Already reloaded for this exact target — don't loop.
    if (sessionStorage.getItem(GUARD_KEY) === daemonVersion) return;
    // Set the guard before reloading so a non-converging version reloads at most once.
    sessionStorage.setItem(GUARD_KEY, daemonVersion);
  } catch {
    // A throwing sessionStorage (historically Safari private mode) must not crash
    // the snapshot handler. Without a durable guard we cannot promise "reload
    // once", so skip the reload entirely rather than risk a loop.
    return;
  }
  location.reload();
}
