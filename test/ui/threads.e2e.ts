// M2c e2e: the full review loop round-trips through a real browser, the real
// daemon, AND the real built CLI — select text → anchored comment → drawer →
// Send all wakes a parked `otacon wait`; ask fires instantly and the rail's
// "answering" placeholder flips to the agent's `otacon answer` over SSE,
// without a reload. Anchors are asserted byte-for-byte against the selection.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Session } from "./helpers.js";
import { createSession, plantMarker, readMarker, submitFixturePlan, uniqueTitle } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "..", "dist", "cli", "main.js");
const port = Number(process.env.OTACON_E2E_PORT ?? "4790");
// The CLI only touches its home when it has to spawn a daemon (it never
// should here — the webServer daemon is up); a temp home keeps a failure from
// ever spilling into the real ~/.otacon.
const cliHome = mkdtempSync(join(tmpdir(), "otacon-ui-e2e-cli-"));

// A test that fails between spawning a parked `otacon wait` and awaiting it
// would otherwise orphan the child to long-poll the daemon for up to 30s past
// the failure; afterEach reaps whatever is still running.
const liveChildren = new Set<ChildProcess>();
test.afterEach(() => {
  for (const child of liveChildren) child.kill("SIGKILL");
  liveChildren.clear();
});

/** Run the REAL built CLI against the e2e daemon; resolves on exit. */
function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        OTACON_PORT: String(port),
        OTACON_HOME: cliHome,
        NO_PROXY: "127.0.0.1,localhost",
      },
    });
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      liveChildren.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      liveChildren.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Select `needle` inside the element at `selector` the way a user would —
 * a real DOM Range over the text node, which fires selectionchange. The
 * string-expression evaluate keeps DOM types out of the server tsconfig.
 */
async function selectText(page: Page, selector: string, needle: string): Promise<void> {
  const found = await page.evaluate(
    `(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return false;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node.nodeValue ?? "").indexOf(${JSON.stringify(needle)});
        if (at !== -1) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + ${needle.length});
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          return true;
        }
      }
      return false;
    })()`,
  );
  expect(found, `could not select ${JSON.stringify(needle)} in ${selector}`).toBe(true);
}

async function openReview(page: Page, request: APIRequestContext, label: string): Promise<Session> {
  const session = await createSession(request, uniqueTitle(label));
  await submitFixturePlan(request, session.id, "valid-plan.md");
  await page.goto(`/s/${session.id}`);
  await expect(page.locator("#summary .md")).toBeVisible();
  return session;
}

test("comment flow: selection → toolbar → drawer → Send all wakes a parked CLI wait", async ({
  page,
  request,
}) => {
  const session = await openReview(page, request, "comment-flow");
  const exact = "short-lived JWTs issued by the auth service";

  await selectText(page, "#summary .md", exact);
  const toolbar = page.locator(".sel-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar.locator(".sel-slug")).toHaveText("#summary");
  await toolbar.locator(".sel-btn", { hasText: "comment" }).click();

  const composer = page.locator(".composer");
  await expect(composer).toBeVisible();
  await expect(composer.locator(".composer-target")).toHaveText("→ #summary");
  await expect(composer.locator(".composer-quote")).toContainText("short-lived JWTs");
  await composer.locator(".composer-input").fill("name the issuing service explicitly");
  await composer.locator(".btn-primary", { hasText: "add to drawer" }).click();

  // Batched, not sent: the drawer holds it (DESIGN.md §9).
  await expect(page.locator(".drawer-count")).toHaveText("1");
  await expect(page.locator(".thread")).toHaveCount(0);

  // Park the REAL CLI on wait, then flush the batch from the browser.
  const parked = runCli(["wait", "--timeout", "30", "--session", session.id]);
  await page.locator(".drawer-bar .btn-primary", { hasText: "send all" }).click();

  const result = await parked;
  expect(result.code).toBe(0);
  const event = JSON.parse(result.stdout) as {
    event: string;
    session: string;
    batch: string;
    items: { thread: string; anchor: { section: string; exact: string; prefix?: string }; body: string }[];
  };
  expect(event.event).toBe("comments");
  expect(event.session).toBe(session.id);
  expect(event.items).toHaveLength(1);
  expect(event.items[0]!.anchor.section).toBe("summary");
  expect(event.items[0]!.anchor.exact).toBe(exact); // the anchor IS the selection
  expect(event.items[0]!.body).toBe("name the issuing service explicitly");

  // Drawer drained; the thread lands in the rail (over SSE) with its quote.
  await expect(page.locator(".drawer-count")).toHaveCount(0);
  const thread = page.locator(".thread-comment");
  await expect(thread).toHaveCount(1);
  await expect(thread.locator(".thread-quote")).toContainText("short-lived JWTs");
  await expect(thread.locator(".thread-where")).toHaveText("#summary");

  // Clicking the anchored thread jumps to and washes the anchored section.
  await thread.click();
  await expect(page.locator("#summary.anchor-hit")).toHaveCount(1);
});

test("per-comment send-now from the drawer flushes just that item", async ({ page, request }) => {
  const session = await openReview(page, request, "send-now");

  // Stack two comments from two different sections.
  await selectText(page, "#summary .md", "token issuance");
  await page.locator(".sel-btn", { hasText: "comment" }).click();
  await page.locator(".composer-input").fill("first: stays in the drawer");
  await page.locator(".btn-primary", { hasText: "add to drawer" }).click();

  await selectText(page, "#decisions .md", "RS256 over HS256");
  await page.locator(".sel-btn", { hasText: "comment" }).click();
  await page.locator(".composer-input").fill("second: send this one now");
  await page.locator(".btn-primary", { hasText: "add to drawer" }).click();
  await expect(page.locator(".drawer-count")).toHaveText("2");

  // Review the batch, send only the second item.
  await page.locator(".drawer-bar .btn-ghost", { hasText: "review" }).click();
  await expect(page.locator(".pending")).toHaveCount(2);
  const second = page.locator(".pending", { hasText: "second: send this one now" });
  const parked = runCli(["wait", "--timeout", "30", "--session", session.id]);
  await second.locator(".pending-act", { hasText: "send now" }).click();

  const result = await parked;
  expect(result.code).toBe(0);
  const event = JSON.parse(result.stdout) as {
    event: string;
    items: { anchor: { section: string; exact: string }; body: string }[];
  };
  expect(event.event).toBe("comments");
  expect(event.items).toHaveLength(1);
  expect(event.items[0]!.anchor.section).toBe("decisions");
  expect(event.items[0]!.body).toBe("second: send this one now");

  // The first comment is still pending; only one thread exists.
  await expect(page.locator(".drawer-count")).toHaveText("1");
  await expect(page.locator(".pending")).toHaveCount(1);
  await expect(page.locator(".thread-comment")).toHaveCount(1);
});

test("ask → instant question; `otacon answer` flips answering→answer over SSE, no reload", async ({
  page,
  request,
}) => {
  const session = await openReview(page, request, "ask-answer");

  await selectText(page, "#decisions .md", "RS256 over HS256");
  await page.locator(".sel-btn", { hasText: "ask" }).click();
  await expect(page.locator(".composer-mode")).toHaveText("ask");
  await page.locator(".composer-input").fill("what breaks if we rotate keys mid-session?");
  await page.locator(".btn-primary", { hasText: "ask now" }).click();

  // Instant: the thread appears in the rail with the answering placeholder,
  // and the session status never flips (questions leave the plan untouched).
  const thread = page.locator(".thread-question");
  await expect(thread).toHaveCount(1);
  await expect(thread.locator(".thread-answering")).toBeVisible();
  await expect(page.locator(".chip")).toHaveText("awaiting your review");

  // The agent's side, through the REAL CLI: wait delivers the question…
  const delivered = await runCli(["wait", "--timeout", "30", "--session", session.id]);
  expect(delivered.code).toBe(0);
  const event = JSON.parse(delivered.stdout) as {
    event: string;
    id: string;
    anchor: { section: string; exact: string };
    body: string;
  };
  expect(event.event).toBe("question");
  expect(event.anchor.section).toBe("decisions");
  expect(event.anchor.exact).toBe("RS256 over HS256");
  expect(event.body).toBe("what breaks if we rotate keys mid-session?");

  // …and `otacon answer` lands on the thread.
  await plantMarker(page);
  const answered = await runCli([
    "answer",
    event.id,
    "--body",
    "Nothing: verifiers fetch the public key set, old tokens verify until expiry.",
    "--session",
    session.id,
  ]);
  expect(answered.code).toBe(0);
  expect((JSON.parse(answered.stdout) as { ok: boolean }).ok).toBe(true);

  await expect(thread.locator(".thread-answer-body")).toHaveText(
    "Nothing: verifiers fetch the public key set, old tokens verify until expiry.",
  );
  await expect(thread.locator(".thread-answering")).toHaveCount(0);
  expect(await readMarker(page)).toBe(true); // SSE, not a reload
});

test("whole-plan comment goes through the drawer affordance with a null anchor", async ({
  page,
  request,
}) => {
  const session = await openReview(page, request, "whole-plan");

  await page.locator(".drawer-whole").click();
  const composer = page.locator(".composer");
  await expect(composer).toHaveClass(/composer-sheet/);
  await expect(composer.locator(".composer-target")).toHaveText("→ whole plan");
  await composer.locator(".composer-input").fill("overall: phase 2 needs its own risks");

  // The composer's own per-comment override sends immediately.
  const parked = runCli(["wait", "--timeout", "30", "--session", session.id]);
  await composer.locator(".btn-ghost", { hasText: "send now" }).click();

  const result = await parked;
  expect(result.code).toBe(0);
  const event = JSON.parse(result.stdout) as {
    event: string;
    items: { anchor: null | object; body: string }[];
  };
  expect(event.event).toBe("comments");
  expect(event.items[0]!.anchor).toBeNull();
  expect(event.items[0]!.body).toBe("overall: phase 2 needs its own risks");

  const thread = page.locator(".thread-comment");
  await expect(thread).toHaveCount(1);
  await expect(thread.locator(".thread-where")).toHaveText("whole plan");
  await expect(thread.locator(".thread-quote")).toHaveCount(0);
});

test("renderer chrome never offers the toolbar — its text is not in the plan source", async ({
  page,
  request,
}) => {
  await openReview(page, request, "chrome-guard");

  // Sanity: prose selections do get the toolbar…
  await selectText(page, "#summary .md", "token issuance");
  await expect(page.locator(".sel-toolbar")).toBeVisible();

  // …but the section's #slug anchor exists only in the rendered DOM — an
  // anchor captured from it could never be re-located, so no toolbar.
  // (The slug renders as two text nodes, "#" + id; selecting the id is enough.)
  await selectText(page, "#summary .anchor-slug", "summary");
  await expect(page.locator(".sel-toolbar")).toHaveCount(0);
});

test("keyboard: c opens the comment composer, q the ask composer, on the selection", async ({
  page,
  request,
}) => {
  await openReview(page, request, "keyboard");

  await selectText(page, "#summary .md", "session-cookie auth");
  await page.keyboard.press("c");
  await expect(page.locator(".composer-mode")).toHaveText("comment");
  await expect(page.locator(".composer-target")).toHaveText("→ #summary");
  await page.keyboard.press("Escape"); // composer's textarea handles Esc
  await expect(page.locator(".composer")).toHaveCount(0);

  await selectText(page, "#summary .md", "session-cookie auth");
  await page.keyboard.press("q");
  await expect(page.locator(".composer-mode")).toHaveText("ask");

  // Typing into the composer must not re-trigger the shortcuts.
  await page.locator(".composer-input").fill("c and q are just letters here");
  await expect(page.locator(".composer-mode")).toHaveText("ask");
});

test("375px viewport: toolbar works, composer becomes a sheet, rail stacks below", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 375, height: 720 });
  const session = await openReview(page, request, "phone-loop");
  // Seed a thread so the rail renders content.
  await request.post(`/api/sessions/${session.id}/questions`, {
    data: { anchor: { section: "summary" }, body: "from the phone" },
  });

  await selectText(page, "#summary .md", "token issuance");
  await expect(page.locator(".sel-toolbar")).toBeVisible();
  await page.locator(".sel-btn", { hasText: "comment" }).click();
  await expect(page.locator(".composer")).toHaveClass(/composer-sheet/);
  await page.locator(".composer-close").click();

  // The rail stacks below the plan on a narrow screen.
  const planBox = await page.locator(".review").boundingBox();
  const railBox = await page.locator(".rail").boundingBox();
  expect(planBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  expect(railBox!.y).toBeGreaterThanOrEqual(planBox!.y + planBox!.height - 1);

  // No horizontal scroll with the drawer and rail mounted.
  const scrollWidth = (await page.evaluate("document.documentElement.scrollWidth")) as number;
  expect(scrollWidth).toBeLessThanOrEqual(375);
});

test("dark scheme renders the loop surfaces", async ({ page, request }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const session = await openReview(page, request, "dark-loop");
  await request.post(`/api/sessions/${session.id}/questions`, {
    data: { anchor: { section: "summary" }, body: "dark mode question" },
  });

  await expect(page.locator(".thread-question")).toBeVisible();
  await expect(page.locator(".thread-answering")).toBeVisible();
  await expect(page.locator(".drawer-whole")).toBeVisible();

  await selectText(page, "#summary .md", "token issuance");
  await expect(page.locator(".sel-toolbar")).toBeVisible();
  // The inverted toolbar flips with the scheme: light surface on dark pages.
  const toolbarBg = (await page.evaluate(
    "getComputedStyle(document.querySelector('.sel-toolbar')).backgroundColor",
  )) as string;
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(toolbarBg);
  expect(match).not.toBeNull();
  const luminance = (Number(match![1]) + Number(match![2]) + Number(match![3])) / 3;
  expect(luminance).toBeGreaterThan(128);
});
