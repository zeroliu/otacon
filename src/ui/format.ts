const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const delta = Math.max(0, now - t);
  if (delta < 45_000) return "just now";
  if (delta < HOUR) return `${Math.round(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.round(delta / HOUR)}h ago`;
  if (delta < 14 * DAY) return `${Math.round(delta / DAY)}d ago`;
  return new Date(t).toLocaleDateString();
}

/** Last path segment of the absolute repo root — enough on a card. */
export function repoName(repoPath: string): string {
  const parts = repoPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? repoPath;
}
