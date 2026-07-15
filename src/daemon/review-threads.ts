// Durable PR-review conversations. They intentionally share the conventional
// per-session `threads.json` pathname with plan sessions but use a version-2
// envelope and a disjoint entry shape, so existing version-1 plan bytes and
// lifecycle semantics remain untouched.

import { existsSync } from "node:fs";
import type {
  Anchor,
  PublicReviewThread,
  ReviewKnowledgeScope,
  ReviewThread,
} from "../shared/types.js";
import { quarantineCorruptFile, readJsonOr, stringify, writeFileAtomic } from "./store.js";

interface ReviewThreadsFile {
  version: 2;
  threads: ReviewThread[];
}

export class ReviewThreadConflictError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const exactKeys = (raw: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(raw).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
};

const isDate = (value: unknown): value is string => {
  if (typeof value !== "string" || value === "") return false;
  const epoch = Date.parse(value);
  return !Number.isNaN(epoch) && new Date(epoch).toISOString() === value;
};
const isPositive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isScope = (value: unknown): value is ReviewKnowledgeScope => value === "user" || value === "project";

function isAnchor(raw: unknown): raw is Anchor {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  if (!exactKeys(value, ["section", "exact", ...(value.prefix === undefined ? [] : ["prefix"]), ...(value.suffix === undefined ? [] : ["suffix"])])) return false;
  return typeof value.section === "string" && value.section.trim() !== "" && value.section.length <= 200 &&
    typeof value.exact === "string" && value.exact.trim() !== "" && value.exact.length <= 10_000 &&
    (value.prefix === undefined || (typeof value.prefix === "string" && value.prefix.length <= 1_000)) &&
    (value.suffix === undefined || (typeof value.suffix === "string" && value.suffix.length <= 1_000));
}

function isIdentity(raw: unknown): raw is ReviewThread["identity"] {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  return exactKeys(value, ["session", "reportRevision", "headRevision", "headSha"]) &&
    typeof value.session === "string" && /^otc_[0-9a-z]{6,64}$/.test(value.session) &&
    isPositive(value.reportRevision) && isPositive(value.headRevision) &&
    typeof value.headSha === "string" && /^[0-9a-f]{40}$/i.test(value.headSha);
}

function isReviewThread(raw: unknown): raw is ReviewThread {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  const optional = ["replyTo", "remember", "response", "saved", "codeAction"].filter((key) => value[key] !== undefined);
  if (!exactKeys(value, ["id", "surface", "intent", "anchor", "body", "createdAt", "identity", "idempotencyKey", ...optional])) return false;
  if (
    value.surface !== "review" || (value.intent !== "question" && value.intent !== "comment") ||
    typeof value.id !== "string" || !/^[qt][1-9]\d{0,8}$/.test(value.id) ||
    (value.intent === "question" ? !value.id.startsWith("q") : !value.id.startsWith("t")) ||
    !isAnchor(value.anchor) || typeof value.body !== "string" || value.body.trim() === "" || value.body.length > 20_000 ||
    !isDate(value.createdAt) || !isIdentity(value.identity) ||
    (value.replyTo !== undefined && (typeof value.replyTo !== "string" || !/^[qt][1-9]\d{0,8}$/.test(value.replyTo))) ||
    typeof value.idempotencyKey !== "string" || value.idempotencyKey.trim() === "" || value.idempotencyKey.length > 200
  ) return false;
  if (value.remember !== undefined) {
    if (typeof value.remember !== "object" || value.remember === null) return false;
    const remember = value.remember as Record<string, unknown>;
    if (!exactKeys(remember, ["scope"]) || !isScope(remember.scope)) return false;
  }
  if (value.response !== undefined) {
    if (typeof value.response !== "object" || value.response === null) return false;
    const response = value.response as Record<string, unknown>;
    if (!exactKeys(response, ["body", "respondedAt", ...(response.reportRevision === undefined ? [] : ["reportRevision"])])) return false;
    if (typeof response.body !== "string" || response.body.trim() === "" || response.body.length > 20_000 || !isDate(response.respondedAt)) return false;
    if (response.reportRevision !== undefined && !isPositive(response.reportRevision)) return false;
    if (value.intent === "comment" ? response.reportRevision === undefined : response.reportRevision !== undefined) return false;
    if (value.intent === "comment" && (response.reportRevision as number) <= (value.identity as ReviewThread["identity"]).reportRevision) return false;
    if (Date.parse(response.respondedAt as string) < Date.parse(value.createdAt as string)) return false;
  }
  if (value.saved !== undefined) {
    if (typeof value.saved !== "object" || value.saved === null) return false;
    const saved = value.saved as Record<string, unknown>;
    if (!exactKeys(saved, ["scope", "savedAt"]) || !isScope(saved.scope) || !isDate(saved.savedAt)) return false;
    if ((value.remember as { scope?: unknown } | undefined)?.scope !== saved.scope) return false;
    const response = value.response as ReviewThread["response"] | undefined;
    if (response === undefined || saved.savedAt !== response.respondedAt) return false;
  }
  if (value.codeAction !== undefined) {
    if (value.intent !== "comment" || typeof value.codeAction !== "object" || value.codeAction === null) return false;
    const action = value.codeAction as Record<string, unknown>;
    if (!exactKeys(action, ["status", "requestedAt", "updatedAt", ...(action.authorizedTurns === undefined ? [] : ["authorizedTurns"]), ...(action.message === undefined ? [] : ["message"])])) return false;
    if (!["requested", "working", "completed", "failed"].includes(String(action.status)) ||
      !isDate(action.requestedAt) || !isDate(action.updatedAt) ||
      (action.authorizedTurns !== undefined && (!Array.isArray(action.authorizedTurns) || action.authorizedTurns.length === 0 ||
        action.authorizedTurns.some((id) => typeof id !== "string" || !/^t[1-9]\d{0,8}$/.test(id)) ||
        new Set(action.authorizedTurns).size !== action.authorizedTurns.length)) ||
      (action.message !== undefined && (typeof action.message !== "string" || action.message.trim() === "" || action.message.length > 20_000))) return false;
    if (Date.parse(action.requestedAt as string) < Date.parse(value.createdAt as string) ||
      Date.parse(action.updatedAt as string) < Date.parse(action.requestedAt as string)) return false;
  }
  return true;
}

function parseReviewThreads(raw: unknown, expectedSession?: string): ReviewThreadsFile | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (!exactKeys(value, ["version", "threads"]) || value.version !== 2 || !Array.isArray(value.threads)) return undefined;
  if (!value.threads.every(isReviewThread)) return undefined;
  const ids = new Set<string>();
  const keys = new Set<string>();
  const sessions = new Set<string>();
  for (const thread of value.threads) {
    if (ids.has(thread.id) || keys.has(thread.idempotencyKey)) return undefined;
    if (expectedSession !== undefined && thread.identity.session !== expectedSession) return undefined;
    ids.add(thread.id);
    keys.add(thread.idempotencyKey);
    sessions.add(thread.identity.session);
  }
  if (sessions.size > 1) return undefined;
  const byId = new Map(value.threads.map((thread) => [thread.id, thread]));
  for (const thread of value.threads) {
    if (thread.replyTo === undefined) continue;
    const root = byId.get(thread.replyTo);
    if (root === undefined || root.replyTo !== undefined || root.intent !== thread.intent ||
      JSON.stringify(root.anchor) !== JSON.stringify(thread.anchor) ||
      root.identity.headRevision !== thread.identity.headRevision || root.identity.headSha !== thread.identity.headSha ||
      thread.identity.reportRevision < root.identity.reportRevision || Date.parse(thread.createdAt) < Date.parse(root.createdAt) ||
      thread.remember !== undefined || thread.codeAction !== undefined) return undefined;
  }
  for (const root of value.threads.filter((thread) => thread.codeAction !== undefined)) {
    const authorized = root.codeAction?.authorizedTurns ?? [root.id];
    const conversationIds = new Set(value.threads.filter((thread) => thread.id === root.id || thread.replyTo === root.id).map((thread) => thread.id));
    if (root.replyTo !== undefined || authorized.some((id) => !conversationIds.has(id))) return undefined;
  }
  return value as unknown as ReviewThreadsFile;
}

export function readReviewThreads(path: string, expectedSession?: string): ReviewThread[] {
  if (!existsSync(path)) return [];
  const file = parseReviewThreads(readJsonOr(path), expectedSession);
  if (file === undefined) {
    quarantineCorruptFile(path, "review threads file");
    return [];
  }
  return file.threads;
}

function writeReviewThreads(path: string, threads: ReviewThread[]): void {
  writeFileAtomic(path, stringify({ version: 2, threads } satisfies ReviewThreadsFile));
}

export function publicReviewThread(thread: ReviewThread): PublicReviewThread {
  const { idempotencyKey: _private, ...publicThread } = thread;
  return structuredClone(publicThread);
}

export function publicReviewThreads(path: string, expectedSession?: string): PublicReviewThread[] {
  return readReviewThreads(path, expectedSession).map(publicReviewThread);
}

function sameCreate(
  existing: ReviewThread,
  input: Omit<ReviewThreadCreate, "id" | "createdAt">,
): boolean {
  const { id: _id, createdAt: _createdAt, response: _response, saved: _saved, codeAction: _codeAction, ...comparable } = existing;
  return JSON.stringify(comparable) === JSON.stringify(input);
}

export type ReviewThreadCreate = Omit<ReviewThread, "response" | "saved" | "codeAction"> & {
  response?: never;
  saved?: never;
  codeAction?: never;
};

export function createReviewThread(
  path: string,
  input: ReviewThreadCreate,
): { thread: ReviewThread; repeated: boolean } {
  if (
    Object.prototype.hasOwnProperty.call(input, "response") ||
    Object.prototype.hasOwnProperty.call(input, "saved") ||
    Object.prototype.hasOwnProperty.call(input, "codeAction") ||
    !isReviewThread(input)
  ) {
    throw new ReviewThreadConflictError("E_REVIEW_THREAD_INVALID", "review thread creation is invalid");
  }
  const threads = readReviewThreads(path, input.identity.session);
  const existing = threads.find((thread) => thread.idempotencyKey === input.idempotencyKey);
  if (existing !== undefined) {
    const { id: _id, createdAt: _createdAt, ...request } = input;
    if (!sameCreate(existing, request)) {
      throw new ReviewThreadConflictError("E_REVIEW_THREAD_IDEMPOTENCY", "idempotency key belongs to a different review thread request");
    }
    return { thread: existing, repeated: true };
  }
  writeReviewThreads(path, [...threads, input]);
  return { thread: input, repeated: false };
}

function validatedMutation(candidate: ReviewThread): ReviewThread {
  if (!isReviewThread(candidate)) {
    throw new ReviewThreadConflictError("E_REVIEW_THREAD_INVALID", "review thread mutation is invalid");
  }
  return candidate;
}

export interface ReviewThreadResponseInput {
  body: string;
  reportRevision?: number;
  saved?: { scope: ReviewKnowledgeScope; updated: true };
}

export function respondToReviewThread(
  path: string,
  id: string,
  input: ReviewThreadResponseInput,
  now: string,
  expectedSession?: string,
): { thread: ReviewThread; repeated: boolean } {
  const threads = readReviewThreads(path, expectedSession);
  const thread = threads.find((candidate) => candidate.id === id);
  if (thread === undefined) throw new ReviewThreadConflictError("E_REVIEW_THREAD_UNKNOWN", `unknown review thread: ${id}`);
  if (thread.intent === "question" && input.reportRevision !== undefined) {
    throw new ReviewThreadConflictError("E_REVIEW_THREAD_RESPONSE", "question answers cannot claim a report revision");
  }
  if (thread.intent === "comment" && input.reportRevision === undefined) {
    throw new ReviewThreadConflictError("E_REVIEW_THREAD_RESPONSE", "comment responses must identify the replacement report revision");
  }
  if (input.saved !== undefined && thread.remember?.scope !== input.saved.scope) {
    throw new ReviewThreadConflictError("E_REVIEW_MEMORY_SCOPE", "saved acknowledgement does not match the requested knowledge scope");
  }
  const response = {
    body: input.body,
    respondedAt: now,
    ...(input.reportRevision === undefined ? {} : { reportRevision: input.reportRevision }),
  };
  const saved = input.saved === undefined ? undefined : { scope: input.saved.scope, savedAt: now };
  if (thread.response !== undefined) {
    const same = thread.response.body === input.body &&
      thread.response.reportRevision === input.reportRevision &&
      thread.saved?.scope === saved?.scope;
    if (!same) throw new ReviewThreadConflictError("E_REVIEW_THREAD_DUPLICATE_RESPONSE", "review thread already has a different response");
    return { thread, repeated: true };
  }
  const updated = validatedMutation({
    ...thread,
    response,
    ...(saved === undefined ? {} : { saved }),
  });
  writeReviewThreads(path, threads.map((candidate) => candidate.id === id ? updated : candidate));
  return { thread: updated, repeated: false };
}

export function requestReviewCodeAction(
  path: string,
  id: string,
  now: string,
  expectedSession?: string,
): { thread: ReviewThread; repeated: boolean } {
  const threads = readReviewThreads(path, expectedSession);
  const thread = threads.find((candidate) => candidate.id === id);
  if (thread === undefined) throw new ReviewThreadConflictError("E_REVIEW_THREAD_UNKNOWN", `unknown review thread: ${id}`);
  if (thread.intent !== "comment") throw new ReviewThreadConflictError("E_REVIEW_CODE_ACTION_KIND", "only a persisted Comment can conduct a code change");
  if (thread.replyTo !== undefined) throw new ReviewThreadConflictError("E_REVIEW_CODE_ACTION_ROOT", "conduct code change on the conversation root");
  if (thread.codeAction !== undefined) return { thread, repeated: true };
  const authorizedTurns = threads
    .filter((candidate) => candidate.id === thread.id || candidate.replyTo === thread.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((candidate) => candidate.id);
  const updated = validatedMutation({
    ...thread,
    codeAction: { status: "requested", requestedAt: now, updatedAt: now, authorizedTurns },
  });
  writeReviewThreads(path, threads.map((candidate) => candidate.id === id ? updated : candidate));
  return { thread: updated, repeated: false };
}

export function updateReviewCodeAction(
  path: string,
  id: string,
  input: { status: "working" | "completed" | "failed"; message?: string },
  now: string,
  expectedSession?: string,
): { thread: ReviewThread; repeated: boolean } {
  const threads = readReviewThreads(path, expectedSession);
  const thread = threads.find((candidate) => candidate.id === id);
  if (thread === undefined) throw new ReviewThreadConflictError("E_REVIEW_THREAD_UNKNOWN", `unknown review thread: ${id}`);
  if (thread.intent !== "comment" || thread.codeAction === undefined) {
    throw new ReviewThreadConflictError("E_REVIEW_CODE_ACTION_NOT_REQUESTED", "code change has not been requested for this Comment");
  }
  if (thread.codeAction.status === input.status && thread.codeAction.message === input.message) {
    return { thread, repeated: true };
  }
  if (thread.codeAction.status === "completed" || thread.codeAction.status === "failed") {
    throw new ReviewThreadConflictError("E_REVIEW_CODE_ACTION_TERMINAL", "code action already reached a terminal state");
  }
  const updated = validatedMutation({
    ...thread,
    codeAction: {
      ...thread.codeAction,
      status: input.status,
      updatedAt: now,
      ...(input.message === undefined ? {} : { message: input.message }),
    },
  });
  writeReviewThreads(path, threads.map((candidate) => candidate.id === id ? updated : candidate));
  return { thread: updated, repeated: false };
}
