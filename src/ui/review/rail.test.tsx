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
 *  early-returns without a focus target). `onResolve` defaults present (a live
 *  session); pass `null` to drop it (the read-only/session-over case). */
function render(
  threads: Thread[],
  opts: { onResolve?: typeof noop | null; onFollowup?: typeof noop } = {},
): string {
  return renderToStaticMarkup(
    createElement(ThreadsRail, {
      threads,
      onJump: () => undefined,
      onFollowup: opts.onFollowup,
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

  test("a detached thread shows a muted quote with a subtle icon + hover tooltip, and is not jumpable", () => {
    const html = render([comment("t1", { anchorState: "orphaned" })]);
    // Muted quote, not the jumpable variant.
    expect(html).toContain("thread-quote-muted");
    expect(html).not.toContain("thread-quote-jump");
    // The detached card is not a clickable jump target.
    expect(html).not.toContain("thread-anchored");
    // A subtle icon carries the explanation in its title (hover tooltip),
    // and that explanation never uses the internal "orphaned" marker word.
    expect(html).toContain("thread-quote-detached");
    expect(html).toContain("changed in a later revision");
    // The original quoted text is still shown (muted), never dropped.
    expect(html).toContain("RS256");
  });

  test("a detached conversation (root + follow-up) stays inline as one muted card", () => {
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

  test("an anchored (non-detached) thread keeps its jump-and-flash affordance", () => {
    const html = render([comment("t1"), question("q1")]);
    // Comment cards are clickable jump targets when anchored.
    expect(html).toContain("thread-anchored");
    // The question's quote and meta both offer the jump.
    expect(html).toContain("thread-quote-jump");
    expect(html).toContain("thread-meta-jump");
    expect(html).toContain("jump to the quoted text");
    // No muted/detached chrome appears on anchored threads.
    expect(html).not.toContain("thread-quote-muted");
    expect(html).not.toContain("thread-quote-detached");
  });
});

describe("ThreadsRail reviewer-driven resolution (comments)", () => {
  test("a responded comment renders the agent's reply plus a Resolve control", () => {
    const html = render([
      comment("t1", { reply: { body: "kept RS256 — public-key verify", revision: 2, repliedAt: AT } }),
    ]);
    // Still the open card (the reviewer hasn't closed it), tagged responded.
    expect(html).toContain('data-thread="t1"');
    expect(html).toContain("thread-responded");
    expect(html).not.toContain("thread-resolved");
    // The reply is shown…
    expect(html).toContain("kept RS256 — public-key verify");
    // …and a Resolve control is offered.
    expect(html).toContain("thread-resolve-btn");
    expect(html).toContain("resolve");
  });

  test("an un-replied open comment still offers a Resolve (withdraw) control", () => {
    const html = render([comment("t1")]);
    expect(html).toContain("thread-resolve-btn");
    expect(html).not.toContain("thread-responded");
  });

  test("a reviewer-resolved comment collapses to the ✓ card (keyed on the close)", () => {
    const html = render([
      comment("t1", {
        reply: { body: "addressed", revision: 2, repliedAt: AT },
        resolved: { revision: 3, at: AT },
      }),
    ]);
    // The collapsed ✓ resolved card, carrying the reviewer's resolved revision.
    expect(html).toContain("thread-resolved");
    expect(html).toContain("resolved-summary");
    expect(html).toContain("r3");
    // The agent's reply still expands inside.
    expect(html).toContain("addressed");
  });

  test("the Resolve control is hidden when onResolve is absent (session over)", () => {
    const html = render([comment("t1", { reply: { body: "done", revision: 2, repliedAt: AT } })], {
      onResolve: null,
    });
    // The reply still renders read-only…
    expect(html).toContain("done");
    // …but no Resolve button.
    expect(html).not.toContain("thread-resolve-btn");
  });
});
