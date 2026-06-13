// Per-device unread tracking: the daemon owns plan state; the browser owns
// "what has this device shown me" (DECISIONS.md "Unread badge state lives in
// the browser, not the daemon").

const KEY = "otacon.seenRevisions";

function read(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function seenRevision(id: string): number {
  const value = read()[id];
  return typeof value === "number" ? value : 0;
}

/**
 * Revisions this device has not opened yet — the one unread derivation every
 * badge shares (index card, switcher chips, the dropdown's ●N), so the
 * surfaces can never disagree about what "unread" means.
 */
export function unreadCount(id: string, revision: number): number {
  return Math.max(0, revision - seenRevision(id));
}

export function markSeen(id: string, revision: number): void {
  if (revision <= seenRevision(id)) return;
  const all = read();
  all[id] = revision;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage unavailable (private mode): badges just stay on
  }
}
