import { createHash } from "node:crypto";

import type { KnowledgeHash } from "../shared/knowledge.js";

/**
 * Bind a report revision to both exact knowledge scopes and the canonical
 * project identity. This stays daemon-only so the browser report parser never
 * pulls Node's crypto implementation into the UI bundle.
 */
export function hashReviewSnapshot(
  userHash: KnowledgeHash,
  projectRepo: string,
  projectHash: KnowledgeHash,
): KnowledgeHash {
  return createHash("sha256")
    .update(`otacon-review-knowledge-v1\0user\0${userHash}\0project\0${projectRepo}\0${projectHash}`, "utf8")
    .digest("hex") as KnowledgeHash;
}
