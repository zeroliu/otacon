// The adapter registry: an ordered list of transcript adapters and the lookup
// the tailer uses to bind a session's repo to the agent that's actually working
// there. `findAdapter(repoRoot)` returns the first adapter whose `locate` finds
// a transcript, or null when none matches — and null is the WHOLE point: a repo
// whose agent has no adapter attaches no tailer and runs on the `otacon
// progress` floor (the graceful-degradation guarantee). Adding an agent (Phase
// 5/6: Codex, OpenCode, …) is one line here plus its adapter module.

import type { TranscriptAdapter, TranscriptHandle } from "./adapter.js";
import { claudeAdapter } from "./claude.js";

/** Ordered adapters; the first whose `locate` matches wins. */
export const ADAPTERS: readonly TranscriptAdapter[] = [claudeAdapter];

/**
 * The first adapter with a located transcript for `repoRoot`, or null when no
 * adapter matches (floor only). Fail-soft: a throwing `locate` is treated as no
 * match, never propagated — one misbehaving adapter must not deny every other
 * agent its stream.
 */
export function findAdapter(
  repoRoot: string,
  adapters: readonly TranscriptAdapter[] = ADAPTERS,
): { adapter: TranscriptAdapter; handle: TranscriptHandle } | null {
  for (const adapter of adapters) {
    let handle: TranscriptHandle | null = null;
    try {
      handle = adapter.locate(repoRoot);
    } catch {
      handle = null;
    }
    if (handle) return { adapter, handle };
  }
  return null;
}
