// Local knowledge has two deliberately different persistence models:
// editable Markdown summaries use compare-and-swap atomic replacement, while
// evidence is immutable JSONL appended one complete record at a time. A bad
// manual edit never wedges the daemon: the file is quarantined beside its
// original path and the store recovers with an empty/default view.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  defaultKnowledgeMarkdown,
  hashKnowledge,
  isKnowledgeEvidence,
  normalizeKnowledgeMarkdown,
  validateKnowledgeMarkdown,
} from "../shared/knowledge.js";
import type {
  KnowledgeDocument,
  KnowledgeEvidence,
  KnowledgeHash,
  KnowledgeTarget,
} from "../shared/knowledge.js";
import {
  projectKnowledgeEvidencePath,
  projectKnowledgePath,
  userKnowledgeEvidencePath,
  userKnowledgePath,
} from "../shared/paths.js";
import { quarantineCorruptFile, writeFileAtomic } from "./store.js";

export class InvalidKnowledgeMarkdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidKnowledgeMarkdownError";
  }
}

export type KnowledgeReplaceResult =
  | { ok: true; document: KnowledgeDocument }
  | { ok: false; current: KnowledgeDocument };

export interface KnowledgeStoreDeps {
  quarantine(path: string, what: string): string;
}

const DEFAULT_DEPS: KnowledgeStoreDeps = { quarantine: quarantineCorruptFile };

function summaryPath(target: KnowledgeTarget): string {
  return target.scope === "user" ? userKnowledgePath() : projectKnowledgePath(target.repo);
}

function evidencePath(target: KnowledgeTarget): string {
  return target.scope === "user"
    ? userKnowledgeEvidencePath()
    : projectKnowledgeEvidencePath(target.repo);
}

function documentFor(target: KnowledgeTarget, markdown: string): KnowledgeDocument {
  return {
    scope: target.scope,
    ...(target.scope === "project" ? { repo: target.repo } : {}),
    path: summaryPath(target),
    markdown,
    hash: hashKnowledge(markdown),
  };
}

function sameTarget(target: KnowledgeTarget, evidence: KnowledgeEvidence): boolean {
  return evidence.scope === target.scope &&
    (target.scope === "user" || evidence.repo === target.repo);
}

export class KnowledgeStore {
  constructor(private readonly deps: KnowledgeStoreDeps = DEFAULT_DEPS) {}

  private quarantine(path: string, what: string): void {
    const aside = this.deps.quarantine(path, what);
    // The generic daemon helper is fail-open because most state can be rebuilt.
    // Knowledge is user-authored/audit data: if the corrupt original is still
    // present, refuse rather than overwrite or append into it.
    if (existsSync(path)) {
      throw new Error(`could not quarantine ${what} at ${path}; expected ${aside}`);
    }
  }

  /** Missing means a neutral balanced baseline; malformed Markdown is quarantined. */
  read(target: KnowledgeTarget): KnowledgeDocument {
    const path = summaryPath(target);
    if (!existsSync(path)) return documentFor(target, defaultKnowledgeMarkdown(target));
    let markdown: string;
    try {
      markdown = readFileSync(path, "utf8");
    } catch {
      this.quarantine(path, "knowledge summary");
      return documentFor(target, defaultKnowledgeMarkdown(target));
    }
    const error = validateKnowledgeMarkdown(markdown);
    if (error !== undefined) {
      this.quarantine(path, "knowledge summary");
      return documentFor(target, defaultKnowledgeMarkdown(target));
    }
    return documentFor(target, markdown);
  }

  /**
   * Replace only the version the editor read. The read, comparison, and rename
   * contain no await/yield, so one daemon serializes competing writers.
   */
  replace(target: KnowledgeTarget, markdown: string, baseHash: KnowledgeHash): KnowledgeReplaceResult {
    const normalized = normalizeKnowledgeMarkdown(markdown);
    const validation = validateKnowledgeMarkdown(normalized);
    if (validation !== undefined) throw new InvalidKnowledgeMarkdownError(validation);
    const current = this.read(target);
    if (current.hash !== baseHash) return { ok: false, current };
    writeFileAtomic(summaryPath(target), normalized);
    return { ok: true, document: documentFor(target, normalized) };
  }

  /** Every valid line is kept oldest-first; one malformed line quarantines the ledger. */
  readEvidence(target: KnowledgeTarget): KnowledgeEvidence[] {
    const path = evidencePath(target);
    if (!existsSync(path)) return [];
    try {
      const text = readFileSync(path, "utf8");
      const records = text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
      if (!records.every((item) => isKnowledgeEvidence(item) && sameTarget(target, item))) {
        throw new Error("invalid knowledge evidence");
      }
      return records as KnowledgeEvidence[];
    } catch {
      this.quarantine(path, "knowledge evidence ledger");
      return [];
    }
  }

  /** Validate the existing ledger first, then append exactly one O_APPEND record. */
  appendEvidence(target: KnowledgeTarget, evidence: KnowledgeEvidence): void {
    if (!isKnowledgeEvidence(evidence) || !sameTarget(target, evidence)) {
      throw new Error("knowledge evidence does not match its target");
    }
    // This both protects a valid prefix from being silently extended after a
    // corrupt tail and quarantines malformed manual edits before rebuilding.
    this.readEvidence(target);
    const path = evidencePath(target);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", flag: "a" });
  }

  /** Deterministic quiz evidence ids make grade retries and crash replay exactly-once. */
  appendEvidenceOnce(target: KnowledgeTarget, evidence: KnowledgeEvidence): boolean {
    const existing = this.readEvidence(target).find((item) => item.id === evidence.id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(evidence)) {
        throw new Error(`knowledge evidence id ${evidence.id} already names different content`);
      }
      return false;
    }
    this.appendEvidence(target, evidence);
    return true;
  }
}
