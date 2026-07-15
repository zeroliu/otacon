import { createHash } from "node:crypto";

/** A lowercase, canonical GitHub `owner/repo` key. */
export type CanonicalGitHubRepo = string & { readonly __canonicalGitHubRepo: unique symbol };

/** SHA-256 over the exact Markdown bytes returned by the knowledge store. */
export type KnowledgeHash = string & { readonly __knowledgeHash: unique symbol };

export type KnowledgeScope = "user" | "project";

export type KnowledgeTarget =
  | { scope: "user" }
  | { scope: "project"; repo: CanonicalGitHubRepo };

export interface KnowledgeDocument {
  scope: KnowledgeScope;
  repo?: CanonicalGitHubRepo;
  path: string;
  markdown: string;
  hash: KnowledgeHash;
}

export type KnowledgeVerdict = "retry" | "pass" | "exposed" | "remembered";

/**
 * One durable fact behind the editable summary. Raw quiz text remains in the
 * review session; the ledger keeps only the compact learning/audit signal.
 */
export interface KnowledgeEvidence {
  id: string;
  scope: KnowledgeScope;
  repo?: CanonicalGitHubRepo;
  sessionId: string;
  pr?: { number: number; headSha: string };
  conceptId: string;
  verdict: KnowledgeVerdict;
  rationale: string;
  at: string;
}

const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const REPOSITORY = /^[a-z0-9._-]+$/;
const HASH = /^[a-f0-9]{64}$/;

/**
 * Normalize the common GitHub spellings used by git, URLs, and agents. GitHub
 * repository identity is case-insensitive, so the storage key is lowercase.
 */
export function canonicalizeGitHubRepo(input: string): CanonicalGitHubRepo | undefined {
  let value = input.trim();
  if (value === "") return undefined;

  const scp = /^(?:[^@\s]+@)?github\.com:([^/\s]+)\/([^/\s]+)$/i.exec(value);
  if (scp) {
    value = `${scp[1]}/${scp[2]}`;
  } else if (/^https?:\/\//i.test(value) || /^ssh:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return undefined;
    }
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    value = parsed.pathname.replace(/^\/+|\/+$/g, "");
  } else {
    value = value.replace(/^github\.com\//i, "").replace(/^\/+|\/+$/g, "");
  }

  if (value.toLowerCase().endsWith(".git")) value = value.slice(0, -4);
  const parts = value.split("/");
  if (parts.length !== 2) return undefined;
  const owner = parts[0]?.toLowerCase();
  const repo = parts[1]?.toLowerCase();
  if (owner === undefined || repo === undefined || !OWNER.test(owner) || !REPOSITORY.test(repo)) {
    return undefined;
  }
  if (repo === "." || repo === "..") return undefined;
  return `${owner}/${repo}` as CanonicalGitHubRepo;
}

export function parseKnowledgeHash(input: string): KnowledgeHash | undefined {
  return HASH.test(input) ? (input as KnowledgeHash) : undefined;
}

export function hashKnowledge(markdown: string): KnowledgeHash {
  return createHash("sha256").update(markdown, "utf8").digest("hex") as KnowledgeHash;
}

export const KNOWLEDGE_SECTIONS = [
  "Preferences",
  "Demonstrated concepts",
  "Needs reinforcement",
  "Code exposure",
] as const;

/** Canonical line endings + one terminal newline keep CAS hashes portable. */
export function normalizeKnowledgeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
}

/** The editor can change prose freely, but the four agent-readable sections stay ordered. */
export function validateKnowledgeMarkdown(markdown: string): string | undefined {
  if (!/^# [^\n]+(?:\n|$)/.test(markdown)) return "Markdown must start with a level-one title";
  let previous = -1;
  for (const section of KNOWLEDGE_SECTIONS) {
    const matches = [...markdown.matchAll(new RegExp(`^## ${section}$`, "gm"))];
    if (matches.length !== 1) return `Markdown must contain exactly one \"## ${section}\" section`;
    const position = matches[0]?.index ?? -1;
    if (position <= previous) return "knowledge sections must use the standard order";
    previous = position;
  }
  return undefined;
}

export function defaultKnowledgeMarkdown(target: KnowledgeTarget): string {
  const title = target.scope === "user"
    ? "# User knowledge"
    : `# Project knowledge — github.com/${target.repo}`;
  return `${title}\n\n## Preferences\n\n- No preferences recorded yet.\n\n## Demonstrated concepts\n\n- None yet.\n\n## Needs reinforcement\n\n- None yet.\n\n## Code exposure\n\n- None yet.\n`;
}

export function isKnowledgeEvidence(value: unknown): value is KnowledgeEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" || item.id === "" ||
    (item.scope !== "user" && item.scope !== "project") ||
    typeof item.sessionId !== "string" || item.sessionId === "" ||
    typeof item.conceptId !== "string" || item.conceptId === "" ||
    !["retry", "pass", "exposed", "remembered"].includes(String(item.verdict)) ||
    typeof item.rationale !== "string" ||
    typeof item.at !== "string" || Number.isNaN(Date.parse(item.at))
  ) return false;
  if (item.scope === "project") {
    if (typeof item.repo !== "string" || canonicalizeGitHubRepo(item.repo) !== item.repo) return false;
  } else if (item.repo !== undefined) {
    return false;
  }
  if (item.pr !== undefined) {
    if (typeof item.pr !== "object" || item.pr === null || Array.isArray(item.pr)) return false;
    const pr = item.pr as Record<string, unknown>;
    if (!Number.isInteger(pr.number) || (pr.number as number) <= 0 || typeof pr.headSha !== "string" || pr.headSha === "") {
      return false;
    }
  }
  return true;
}
