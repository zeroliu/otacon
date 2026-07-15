import { describe, expect, test } from "bun:test";
import { balancedFixture } from "./fixtures.js";
import { LiveReviewAdapter, unresolvedThreadCount } from "./model.js";
import type { QuizDefinition, ReviewThread, ThreadDraft } from "./model.js";

function passed(quizzes: QuizDefinition[], id: string): QuizDefinition[] {
  return quizzes.map((quiz) => quiz.id === id
    ? { ...quiz, status: "passed", feedback: "Understood.", knowledgeScope: "project" }
    : quiz);
}

describe("LiveReviewAdapter quiz transport", () => {
  test("optimistically gates a double click behind one request", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let adapter!: LiveReviewAdapter;
    adapter = new LiveReviewAdapter(structuredClone(balancedFixture), async (id): Promise<QuizDefinition[]> => {
      calls += 1;
      await wait;
      return passed(adapter.getSnapshot().quizzes, id);
    });
    const first = adapter.submitQuiz("q1", "same answer");
    const second = adapter.submitQuiz("q1", "same answer");
    expect(calls).toBe(1);
    expect(adapter.getSnapshot().quizzes[0]?.status).toBe("grading");
    release?.();
    await Promise.all([first, second]);
    expect(adapter.getSnapshot().quizzes[0]?.status).toBe("passed");
  });

  test("reuses one idempotency key after response loss and mints a new key for edited text", async () => {
    const seen: Array<{ answer: string; key: string }> = [];
    let fail = true;
    let adapter!: LiveReviewAdapter;
    adapter = new LiveReviewAdapter(structuredClone(balancedFixture), async (id, answer, key): Promise<QuizDefinition[]> => {
      seen.push({ answer, key });
      if (fail) {
        fail = false;
        throw new Error("response lost");
      }
      return passed(adapter.getSnapshot().quizzes, id);
    });
    await adapter.submitQuiz("q1", "same answer");
    expect(adapter.getSnapshot().quizzes[0]).toMatchObject({ status: "retry", answer: "same answer" });
    // A parent session frame or quiz SSE projection may replace the visible
    // snapshot between transport failure and the user's retry. It must not
    // erase the adapter-private durable request identity.
    adapter.replaceSnapshot(structuredClone(balancedFixture));
    await adapter.submitQuiz("q1", "same answer");
    expect(seen[1]?.key).toBe(seen[0]?.key);

    fail = true;
    await adapter.submitQuiz("q2", "first wording");
    await adapter.submitQuiz("q2", "edited wording");
    expect(seen.at(-1)?.key).not.toBe(seen.at(-2)?.key);
  });

  test("a late transport failure cannot regress an authoritative quiz SSE state", async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    const response = new Promise<QuizDefinition[]>((_resolve, reject) => { rejectRequest = reject; });
    const adapter = new LiveReviewAdapter(structuredClone(balancedFixture), async () => response);
    const request = adapter.submitQuiz("q1", "server accepted answer");
    adapter.replaceSnapshot({
      ...adapter.getSnapshot(),
      quizzes: passed(adapter.getSnapshot().quizzes, "q1").map((quiz) => quiz.id === "q1"
        ? { ...quiz, answer: "server accepted answer" }
        : quiz),
    });
    rejectRequest?.(new Error("response lost after SSE pass"));
    await request;
    expect(adapter.getSnapshot().quizzes[0]).toMatchObject({
      status: "passed",
      answer: "server accepted answer",
      feedback: "Understood.",
    });
  });

  test("a late transport success cannot replace a newer authoritative quiz SSE state", async () => {
    let resolveRequest: ((quizzes: QuizDefinition[]) => void) | undefined;
    const response = new Promise<QuizDefinition[]>((resolve) => { resolveRequest = resolve; });
    const adapter = new LiveReviewAdapter(structuredClone(balancedFixture), async () => response);
    const request = adapter.submitQuiz("q1", "server accepted answer");
    const authoritative = passed(adapter.getSnapshot().quizzes, "q1").map((quiz) => quiz.id === "q1"
      ? { ...quiz, answer: "server accepted answer", feedback: "Newer SSE verdict." }
      : quiz);
    adapter.replaceSnapshot({ ...adapter.getSnapshot(), quizzes: authoritative });
    resolveRequest?.(balancedFixture.quizzes);
    await request;
    expect(adapter.getSnapshot().quizzes[0]).toMatchObject({
      status: "passed",
      answer: "server accepted answer",
      feedback: "Newer SSE verdict.",
    });
  });
});

describe("LiveReviewAdapter conversation transport", () => {
  const draft: ThreadDraft = {
    intent: "comment",
    anchor: "selected code",
    sourceAnchor: { section: "code-interface", exact: "selected code", prefix: "before", suffix: "after" },
    body: "Keep the boundary explicit.",
    remember: true,
    scope: "project",
  };

  test("reuses the durable create key after response loss and keeps full anchor identity", async () => {
    const seen: string[] = [];
    let fail = true;
    const create = async (input: ThreadDraft, key: string): Promise<ReviewThread> => {
      seen.push(key);
      if (fail) {
        fail = false;
        throw new Error("response lost");
      }
      return {
        id: "t9", intent: input.intent, anchor: input.anchor, sourceAnchor: input.sourceAnchor,
        body: input.body, status: "open", identity: { reportRevision: 2, headRevision: 1, headSha: "a".repeat(40) },
      };
    };
    const adapter = new LiveReviewAdapter(structuredClone(balancedFixture), undefined, create);
    await expect(adapter.createThread(draft)).rejects.toThrow("response lost");
    adapter.replaceSnapshot(structuredClone(balancedFixture));
    await adapter.createThread(draft);
    expect(seen[1]).toBe(seen[0]);
    expect(adapter.getSnapshot().threads.at(-1)).toMatchObject({ id: "t9", sourceAnchor: draft.sourceAnchor });
  });

  test("conducts code work only through a persisted Comment callback", async () => {
    const fixture = structuredClone(balancedFixture);
    fixture.threads = [{
      id: "t1", intent: "comment", anchor: "quote", body: "change", status: "answered",
      identity: { reportRevision: 1, headRevision: 1, headSha: "a".repeat(40) },
    }];
    const adapter = new LiveReviewAdapter(fixture, undefined, undefined, async (thread) => ({
      ...thread, status: "change-requested", codeActionStatus: "requested",
    }));
    await adapter.conductCodeChange("t1");
    expect(adapter.getSnapshot().threads[0]).toMatchObject({ status: "change-requested", codeActionStatus: "requested" });
  });

  test("creates a same-kind follow-up with a stable retry key and no inherited memory request", async () => {
    const fixture = structuredClone(balancedFixture);
    fixture.threads = [{
      id: "q1", intent: "question", anchor: "quote", body: "why?", status: "answered", response: "because",
      createdAt: "2026-07-15T10:00:00.000Z",
      identity: { reportRevision: 1, headRevision: 1, headSha: "a".repeat(40) },
    }];
    const seen: string[] = [];
    let fail = true;
    const followup = async (root: ReviewThread, body: string, key: string): Promise<ReviewThread> => {
      seen.push(key);
      if (fail) { fail = false; throw new Error("response lost"); }
      return {
        id: "q2", intent: root.intent, anchor: root.anchor, body, replyTo: root.id,
        createdAt: "2026-07-15T10:01:00.000Z", status: "open",
      };
    };
    const adapter = new LiveReviewAdapter(fixture, undefined, undefined, undefined, undefined, followup);
    await expect(adapter.createFollowup("q1", "and now?")).rejects.toThrow("response lost");
    adapter.replaceSnapshot(fixture);
    await adapter.createFollowup("q1", "and now?");
    expect(seen[1]).toBe(seen[0]);
    expect(adapter.getSnapshot().threads.at(-1)).toMatchObject({ id: "q2", intent: "question", replyTo: "q1" });
    expect(adapter.getSnapshot().threads.at(-1)?.knowledgeScope).toBeUndefined();
  });

  test("coalesces concurrent code-change requests per persisted Comment", async () => {
    const fixture = structuredClone(balancedFixture);
    fixture.threads = [{
      id: "t1",
      intent: "comment",
      anchor: "quote",
      body: "change",
      status: "answered",
      identity: { reportRevision: 1, headRevision: 1, headSha: "a".repeat(40) },
    }];
    let calls = 0;
    let release: (() => void) | undefined;
    const adapter = new LiveReviewAdapter(fixture, undefined, undefined, async (thread) => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return { ...thread, status: "change-requested", codeActionStatus: "requested" };
    });
    const first = adapter.conductCodeChange("t1");
    const second = adapter.conductCodeChange("t1");
    expect(calls).toBe(1);
    release?.();
    await Promise.all([first, second]);
    expect(adapter.getSnapshot().threads[0]).toMatchObject({
      status: "change-requested",
      codeActionStatus: "requested",
    });
  });

  test("marks the report closed only after durable Done succeeds", async () => {
    const calls: boolean[] = [];
    let fail = true;
    const adapter = new LiveReviewAdapter(
      structuredClone(balancedFixture),
      undefined,
      undefined,
      undefined,
      async (force) => {
        calls.push(force);
        if (fail) {
          fail = false;
          throw new Error("completion rejected");
        }
      },
    );
    await expect(adapter.close(true)).rejects.toThrow("completion rejected");
    expect(adapter.getSnapshot().closed).toBe(false);
    await adapter.close(true);
    expect(calls).toEqual([true, true]);
    expect(adapter.getSnapshot().closed).toBe(true);
  });

  test("coalesces concurrent Done calls and does not reopen on an older SSE frame", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const adapter = new LiveReviewAdapter(
      structuredClone(balancedFixture),
      undefined,
      undefined,
      undefined,
      async () => {
        calls += 1;
        await new Promise<void>((resolve) => { release = resolve; });
      },
    );
    const first = adapter.close(false);
    const second = adapter.close(false);
    expect(calls).toBe(1);
    release?.();
    await Promise.all([first, second]);
    expect(adapter.getSnapshot().closed).toBe(true);
    adapter.replaceSnapshot({ ...structuredClone(balancedFixture), closed: false });
    expect(adapter.getSnapshot().closed).toBe(true);
  });

  test("does not count preserved unresolved conversations from an older head", () => {
    const fixture = structuredClone(balancedFixture);
    fixture.pr.headSha = "b".repeat(40);
    fixture.threads = [
      { id: "q1", intent: "question", anchor: "old", body: "old", status: "open", identity: { reportRevision: 1, headRevision: 1, headSha: "a".repeat(40) } },
      { id: "q2", intent: "question", anchor: "new", body: "new", status: "open", identity: { reportRevision: 2, headRevision: 2, headSha: "b".repeat(40) } },
    ];
    expect(unresolvedThreadCount(fixture)).toBe(1);
  });
});
