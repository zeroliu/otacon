// Turning a raw capture (a tool call, a text/thinking chunk, an `otacon
// progress` highlight) into a normalized StreamEvent the UI can safely render:
// secrets redacted out of the detail, detail and label truncated to the
// configured caps. Pure functions — the daemon stamps `seq` and `at` and calls
// `normalize`; future transcript adapters emit `RawStreamEvent` and reuse this
// exact path, so redaction and truncation can never be skipped on a capture
// source. Redaction is best-effort, never a security boundary: it catches the
// obvious shapes (a leaked key in a printed env, a bearer header) so they don't
// land in a review screen, but a determined exfiltration is out of scope.

import type { StreamConfig } from "../../shared/config.js";
import type { StreamEvent, StreamKind } from "../../shared/types.js";

export const REDACTED = "[redacted]";

/**
 * What an adapter (or the progress route) hands `normalize`: the un-stamped,
 * un-redacted, un-truncated event. The daemon owns `seq` and `at`; everything
 * here is the capture source's to fill. This is the stable interface future
 * phases (the transcript adapter + tailer) emit against.
 */
export interface RawStreamEvent {
  kind: StreamKind;
  label: string;
  detail?: string;
  /** Raw tool name when `kind === "tool"`. */
  tool?: string;
  status?: "running" | "ok" | "error";
}

// Best-effort secret shapes. Each pattern targets one well-known leak form;
// order is irrelevant (they don't overlap destructively). Anchored loosely so a
// secret embedded in a larger line (a printed env, a curl command) still
// matches.
const SECRET_PATTERNS: readonly RegExp[] = [
  // PEM private-key blocks (multi-line). Must run first conceptually, but the
  // global replace order is fine since the block boundaries are unambiguous.
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  // AWS access key ids.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bearer tokens in an Authorization header / log line.
  /\bBearer\s+[A-Za-z0-9._\-+/=]+/gi,
  // `token=...`, `password=...`, `secret=...`, `api[_-]?key=...` (env/query/CLI
  // shapes), the value running to a quote, whitespace, comma, or semicolon.
  /\b(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret)\s*[=:]\s*["']?[^\s"',;]+/gi,
  // Provider-style key prefixes (OpenAI `sk-`, GitHub `ghp_`/`gho_`/`ghs_`,
  // Slack `xox.-`, Google `AIza`) carrying a long opaque tail.
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/g,
  /\bgh[posu]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_\-]{20,}\b/g,
  // `.env`-style `KEY=secret`: an UPPER_SNAKE name whose value looks
  // secret-ish (long, or mixed case+digits). Conservative on the value so a
  // plain `PORT=3000` or `NODE_ENV=production` is left alone.
  /\b[A-Z][A-Z0-9_]{2,}=(?=[^\s]*[A-Za-z])(?=[^\s]*\d)[A-Za-z0-9._\-+/=]{12,}/g,
];

/**
 * Strip obvious secrets, replacing each match with `[redacted]`. Best-effort:
 * covers API keys, bearer/`token=`/`password=` pairs, AWS `AKIA…` ids, PEM
 * private-key blocks, and `.env`-style `KEY=secret`. Leaves ordinary config
 * (`PORT=3000`, `Bearer`-less prose) untouched.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Cap `text` to `max` characters, marking a cut with a single trailing ellipsis
 * (so the last visible char is `…`, total length stays `max`). `max <= 0`
 * yields the empty string; text within the cap is returned unchanged.
 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  return text.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Produce the final StreamEvent: `detail` is redacted then truncated to
 * `cfg.detailMaxChars`; `label` is truncated to `cfg.labelMaxChars`. `seq` and
 * `at` are the daemon's (it owns the monotonic counter and the clock). An empty
 * `detail` after redaction/truncation is dropped (no key kept on the event).
 * `tool` is preserved as-is (a tool name is short and not a secret); `status`
 * passes through.
 */
export function normalize(
  raw: RawStreamEvent,
  cfg: StreamConfig,
  seq: number,
  at: string,
): StreamEvent {
  const event: StreamEvent = {
    seq,
    at,
    kind: raw.kind,
    label: truncate(raw.label, cfg.labelMaxChars),
  };
  if (raw.detail !== undefined) {
    const detail = truncate(redactSecrets(raw.detail), cfg.detailMaxChars);
    if (detail !== "") event.detail = detail;
  }
  if (raw.tool !== undefined) event.tool = raw.tool;
  if (raw.status !== undefined) event.status = raw.status;
  return event;
}
