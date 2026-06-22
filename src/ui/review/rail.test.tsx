import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ThreadsRail } from "./rail.js";
import type { Thread } from "../api";

const AT = "2026-06-21T00:00:00.000Z";

const comment = (id: string, extra: Partial<Extract<Thread, { kind: "comment" }>> = {}): Thread => ({
  id,
  kind: "comment",
  batch: "b1",
  anchor: { section: "phase-1", exact: "RS256" },
  body: `comment ${id}`,
  createdAt: AT,
  ...extra,
});

const question = (id: string, extra: Partial<Extract<Thread, { kind: "question" }>> = {}): Thread => ({
  id,
  kind: "question",
  anchor: { section: "decisions", exact: "drop refresh tokens" },
  body: `question ${id}`,
  createdAt: AT,
  ...extra,
});

const noop = async () => true;

/** Render the rail to static markup (effects skipped — the focus effect
 *  early-returns without a focus target). `onResolve`/`onFollowup` default
 *  present (a live session); pass `null` to drop them (read-only/session-over). */
function render(
  threads: Thread[],
  opts: { onResolve?: typeof noop | null; onFollowup?: typeof noop | null } = {},
): string {
  return renderToStaticMarkup(
    createElement(ThreadsRail, {
      threads,
      onJump: () => undefined,
      onFollowup: opts.onFollowup === null ? undefined : (opts.onFollowup ?? noop),
      onResolve: opts.onResolve === null ? undefined : (opts.onResolve ?? noop),
    }),
  );
}

describe("ThreadsRail detached threads (anchorState orphaned)", () => {
  test("a detached comment renders inline in the normal list, with no tray and no 'orphaned' anywhere", () => {
    const html = render([comment("t1"), comment("t2", { anchorState: "orphaned" })]);
    // Both threads are in the one inline list, detached one included.
    expect(html).toContain('data-thread="t1"');
    expect(html).toContain('data-thread="t2"');
    // No tray chrome of any kind.
    expect(html).not.toContain("orphan-toggle");
    expect(html).not.toContain("orphan-tray");
    expect(html).not.toContain("orphan-note");
    // The word never reaches the user.
    expect(html.toLowerCase()).not.toContain("orphan");
    // The count tallies every conversation, detached included.
    expect(html).toContain('class="rail-count">2<');
  });

  test("a detached comment shows a muted quote with a subtle icon + hover tooltip, and is not jumpable", () => {
    const html = render([comment("t1", { anchorState: "orphaned" })]);
    // Muted quote, not the jumpable variant.
    expect(html).toContain("thread-quote-muted");
    expect(html).not.toContain("thread-quote-jump");
    // The detached conversation's meta row offers no jump.
    expect(html).not.toContain("thread-meta-jump");
    // A subtle icon carries the explanation in its title (hover tooltip),
    // and that explanation never uses the internal "orphaned" marker word.
    expect(html).toContain("thread-quote-detached");
    expect(html).toContain("changed in a later revision");
    // The original quoted text is still shown (muted), never dropped.
    expect(html).toContain("RS256");
  });

  test("a detached question conversation (root + follow-up) stays inline as one muted card", () => {
    const html = render([
      question("q1", { anchorState: "orphaned" }),
      question("q2", { replyTo: "q1", createdAt: "2026-06-21T00:01:00.000Z" }),
    ]);
    expect(html).toContain('data-thread="q1"');
    expect(html).toContain("thread-conversation");
    expect(html).toContain("thread-quote-muted");
    // The whole chain travels together: the follow-up turn renders inline.
    expect(html).toContain("question q2");
    // No jump affordance on the detached conversation's meta/quote.
    expect(html).not.toContain("thread-meta-jump");
    expect(html).not.toContain("thread-quote-jump");
    expect(html.toLowerCase()).not.toContain("orphan");
  });

  test("a detached comment conversation (root + follow-up) stays inline as one muted card", () => {
    const html = render([
      comment("t1", { anchorState: "orphaned" }),
      comment("t2", { replyTo: "t1", createdAt: "2026-06-21T00:01:00.000Z" }),
    ]);
    expect(html).toContain('data-thread="t1"');
    expect(html).toContain("thread-conversation");
    expect(html).toContain("thread-quote-muted");
    // The whole chain travels together: the follow-up turn renders inline.
    expect(html).toContain("comment t2");
    // No jump affordance on the detached conversation's meta/quote.
    expect(html).not.toContain("thread-meta-jump");
    expect(html).not.toContain("thread-quote-jump");
    expect(html.toLowerCase()).not.toContain("orphan");
  });

  test("a detached resolved comment expands to a muted quote, not a jumpable one", () => {
    const html = render([
      comment("t1", {
        anchorState: "orphaned",
        reply: { body: "fixed it", revision: 2, repliedAt: AT },
        resolved: { revision: 3, at: AT }, // the reviewer's close keys the ✓ card
      }),
    ]);
    // It still collapses to its ✓ line and keeps the agent's reply…
    expect(html).toContain("resolved");
    expect(html).toContain("fixed it");
    // …but the quote inside is muted, never the jumpable variant.
    expect(html).toContain("thread-quote-muted");
    expect(html).not.toContain("thread-quote-jump");
    expect(html).not.toContain("jump to the quoted text");
    expect(html).toContain("RS256");
    expect(html.toLowerCase()).not.toContain("orphan");
  });

  test("an anchored (non-detached) conversation keeps its jump-and-flash affordance", () => {
    const html = render([comment("t1"), question("q1")]);
    // Both kinds offer the jump on their quote + meta when anchored.
    expect(html).toContain("thread-quote-jump");
    expect(html).toContain("thread-meta-jump");
    expect(html).toContain("jump to the quoted text");
    // No muted/detached chrome appears on anchored threads.
    expect(html).not.toContain("thread-quote-muted");
    expect(html).not.toContain("thread-quote-detached");
  });
});

describe("ThreadsRail question conversations", () => {
  test("a question and its follow-up turns each render with the agent's answer", () => {
    const html = render([
      question("q1", { answer: { body: "yes — RS256", answeredAt: AT } }),
      question("q2", {
        replyTo: "q1",
        body: "and the refresh path?",
        answer: { body: "dropped entirely", answeredAt: AT },
        createdAt: "2026-06-21T00:01:00.000Z",
      }),
    ]);
    // One conversation card carrying both turns + both answers.
    expect(html).toContain('data-thread="q1"');
    expect(html).toContain("thread-conversation");
    expect(html).toContain("yes — RS256");
    expect(html).toContain("and the refresh path?");
    expect(html).toContain("dropped entirely");
    // The follow-up turn shows the "↳ you" prompt line.
    expect(html).toContain("thread-followup-turn");
    // An answered question's pending cursor never shows.
    expect(html).not.toContain("answering");
  });

  test("an unanswered question turn shows the blinking 'answering' cursor", () => {
    const html = render([question("q1")]);
    expect(html).toContain("answering");
    // It still carries the follow-up box + a Resolve control.
    expect(html).toContain("thread-followup-open");
    expect(html).toContain("thread-resolve-btn");
  });

  test("a reviewer-resolved question conversation shows its inline ✓ mark + a Reopen control, not the collapsed comment card", () => {
    const html = render([
      question("q1", {
        answer: { body: "settled", answeredAt: AT },
        resolved: { revision: 4, at: AT },
      }),
    ]);
    // Inline resolved mark inside the still-open conversation article…
    expect(html).toContain("thread-resolved-mark");
    expect(html).toContain("r4");
    // …not the collapsed comment ✓ summary, and no follow-up box…
    expect(html).not.toContain("resolved-summary");
    expect(html).not.toContain("thread-followup-open");
    // …but it offers Reopen (re-open the resolved conversation).
    expect(html).toContain("thread-resolve-btn");
    expect(html).toContain("reopen");
  });

  test("a resolved question conversation hides Reopen when the session is over (read-only)", () => {
    const html = render(
      [question("q1", { answer: { body: "settled", answeredAt: AT }, resolved: { revision: 4, at: AT } })],
      { onResolve: null, onFollowup: null },
    );
    expect(html).toContain("thread-resolved-mark");
    expect(html).not.toContain("thread-resolve-btn");
    expect(html).not.toContain("reopen");
  });
});

describe("ThreadsRail comment conversations", () => {
  test("a comment and its follow-up turns each render with the agent's reply", () => {
    const html = render([
      comment("t1", { reply: { body: "kept RS256 — public-key verify", revision: 2, repliedAt: AT } }),
      comment("t2", {
        replyTo: "t1",
        body: "what about key rotation?",
        reply: { body: "added a rotation note", revision: 3, repliedAt: AT },
        createdAt: "2026-06-21T00:01:00.000Z",
      }),
    ]);
    // One conversation card carrying both turns + both replies.
    expect(html).toContain('data-thread="t1"');
    expect(html).toContain("thread-comment");
    expect(html).toContain("thread-conversation");
    expect(html).toContain("kept RS256 — public-key verify");
    expect(html).toContain("what about key rotation?");
    expect(html).toContain("added a rotation note");
    // The reply labels carry the revision the agent landed each on.
    expect(html).toContain("↳ agent · r2");
    expect(html).toContain("↳ agent · r3");
    // The follow-up turn shows the "↳ you" prompt line.
    expect(html).toContain("thread-followup-turn");
  });

  test("an un-replied comment turn shows the pending 'responding' state", () => {
    const html = render([comment("t1")]);
    expect(html).toContain("responding");
  });

  test("an open comment conversation carries a Resolve control and a Follow-up box", () => {
    const html = render([comment("t1")]);
    // Withdraw/Resolve control…
    expect(html).toContain("thread-resolve-btn");
    // …and the collapsed Follow-up box.
    expect(html).toContain("thread-followup-open");
  });

  test("a reviewer-resolved comment conversation collapses to ✓ and still shows its turns when expanded", () => {
    const html = render([
      comment("t1", {
        reply: { body: "addressed", revision: 2, repliedAt: AT },
        resolved: { revision: 3, at: AT },
      }),
      comment("t2", {
        replyTo: "t1",
        body: "follow-up note",
        reply: { body: "and that too", revision: 3, repliedAt: AT },
        createdAt: "2026-06-21T00:01:00.000Z",
      }),
    ]);
    // The collapsed ✓ resolved card, carrying the reviewer's resolved revision.
    expect(html).toContain("thread-resolved");
    expect(html).toContain("resolved-summary");
    expect(html).toContain("r3");
    // The whole conversation expands inside: root reply + the follow-up turn + its reply.
    expect(html).toContain("addressed");
    expect(html).toContain("follow-up note");
    expect(html).toContain("and that too");
    // Resolved cards don't offer the follow-up box (the conversation is closed)…
    expect(html).not.toContain("thread-followup-open");
    // …but they offer a Reopen control to re-open the conversation.
    expect(html).toContain("thread-resolve-btn");
    expect(html).toContain("reopen");
  });

  test("the Resolve + Follow-up controls hide when the session is over (read-only)", () => {
    const html = render([comment("t1", { reply: { body: "done", revision: 2, repliedAt: AT } })], {
      onResolve: null,
      onFollowup: null,
    });
    // The reply still renders read-only…
    expect(html).toContain("done");
    // …but no Resolve button and no follow-up box.
    expect(html).not.toContain("thread-resolve-btn");
    expect(html).not.toContain("thread-followup-open");
  });
});
