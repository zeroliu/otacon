import { useEffect, useState } from "react";

/**
 * A `Date.now()` that refreshes every `ms`, so time-derived UI — relative
 * timestamps, the agent live/offline dot — stays honest while the screen idles
 * between SSE frames. One interval per caller; share the return value across a
 * subtree rather than mounting a dot-per-interval.
 */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
