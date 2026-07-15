import { describe, expect, test } from "bun:test";
import { balancedFixture } from "./fixtures.js";
import { LiveReviewAdapter } from "./model.js";
import type { QuizDefinition } from "./model.js";

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
});
