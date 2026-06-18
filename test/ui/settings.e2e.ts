// UI e2e for the Settings screen's scope inheritance + auto-save (DESIGN.md §10,
// §16): the Project view shows the user profile's override as a field's default;
// the User view flags a field the compared project overrides; sections lead with
// worktree then notifications; and edits persist on blur / toggle with no Save
// button (DECISIONS.md "Settings auto-saves on blur"). Driven over the real built
// daemon (see playwright.config.ts). The e2e OTACON_HOME seeds the *user* scope
// with notifications.desktop=false, so that field inherits a non-default value.
// The auto-save tests edit a fresh session's *project* scope so they can't race
// the shared user scope the inheritance tests read.

import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { createSession, uniqueTitle } from "./helpers.js";

/** Set a project scope file (committed or ·local) through the real API. */
async function setConfig(
  request: APIRequestContext,
  scope: "project" | "project.local",
  repo: string,
  values: Record<string, unknown>,
): Promise<void> {
  const res = await request.post("/api/config", { data: { scope, repo, values } });
  expect(res.status()).toBe(200);
}

/** Set the committed project scope file (<repo>/.otacon/config.json). */
const setProjectConfig = (request: APIRequestContext, repo: string, values: Record<string, unknown>) =>
  setConfig(request, "project", repo, values);

// A field row located by its visible label, so a hint/input assertion can scope
// to exactly that setting (labels are unique within the schema).
const row = (page: import("@playwright/test").Page, label: string) =>
  page.locator(".field-row", { hasText: label });

test("Project view shows the user profile's value as a field's default", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("settings-inherit"));
  // Project overrides only summaryLines; desktop is left to inherit the user
  // scope's false (seeded in playwright.config.ts).
  await setProjectConfig(request, session.repo, { budgets: { summaryLines: 9 } });

  await page.goto(`/settings?repo=${encodeURIComponent(session.repo)}`);
  await page.getByRole("tab", { name: "project", exact: true }).click();

  // Desktop notifications is unset at the project level, so it inherits the
  // user profile's false — flagged, and unchecked (not the schema default true).
  const desktop = row(page, "Desktop notifications");
  await expect(desktop.locator(".field-inherit")).toHaveText("default from user profile");
  await expect(page.getByLabel("Desktop notifications")).not.toBeChecked();

  // The project override itself shows its value, no inherit flag.
  await expect(page.getByLabel("Summary lines")).toHaveValue("9");
  await expect(row(page, "Summary lines").locator(".field-inherit")).toHaveCount(0);
});

test("User view flags a field the compared project overrides", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("settings-override"));
  await setProjectConfig(request, session.repo, { budgets: { summaryLines: 9 } });

  // Land on the User tab (the default) with the repo as the compare target.
  await page.goto(`/settings?repo=${encodeURIComponent(session.repo)}`);

  // summaryLines is overridden by the project → flagged on the user profile.
  await expect(row(page, "Summary lines").locator(".field-override")).toHaveText(
    "overridden by project",
  );
  // Desktop notifications is NOT overridden by this project (only summaryLines
  // is), so no flag — even though the user scope itself sets it.
  await expect(row(page, "Desktop notifications").locator(".field-override")).toHaveCount(0);
});

test("Project · local view inherits the project value as its default", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("settings-local-inherit"));
  // The committed project sets summaryLines=9; project·local leaves it unset, so
  // it must inherit the project value (not the user's 8 nor the schema default).
  await setProjectConfig(request, session.repo, { budgets: { summaryLines: 9 } });

  await page.goto(`/settings?repo=${encodeURIComponent(session.repo)}`);
  await page.getByRole("tab", { name: "project · local" }).click();

  await expect(row(page, "Summary lines").locator(".field-inherit")).toHaveText(
    "default from project",
  );
  // Unset at the local level → the placeholder is the inherited project value.
  await expect(page.getByLabel("Summary lines")).toHaveAttribute("placeholder", "9");
  // Desktop is set only by the user scope → falls through project to the user.
  await expect(row(page, "Desktop notifications").locator(".field-inherit")).toHaveText(
    "default from user profile",
  );
});

test("a project · local override wins over the committed project value", async ({
  page,
  request,
}) => {
  const session = await createSession(request, uniqueTitle("settings-local-override"));
  await setProjectConfig(request, session.repo, { budgets: { summaryLines: 9 } });
  // Personal override: project·local pins summaryLines=11 on top of project's 9.
  await setConfig(request, "project.local", session.repo, { budgets: { summaryLines: 11 } });

  // On the committed Project tab, summaryLines is flagged as shadowed by ·local.
  await page.goto(`/settings?repo=${encodeURIComponent(session.repo)}`);
  await page.getByRole("tab", { name: "project", exact: true }).click();
  await expect(page.getByLabel("Summary lines")).toHaveValue("9");
  await expect(row(page, "Summary lines").locator(".field-override")).toHaveText(
    "overridden by project · local",
  );

  // Saving a fresh ·local value (12) through the UI persists to config.local.json
  // and survives a reload — it's the winning layer.
  await page.getByRole("tab", { name: "project · local" }).click();
  await expect(page.getByLabel("Summary lines")).toHaveValue("11");
  const input = page.getByLabel("Summary lines");
  await input.fill("12");
  const saved = configPost(page);
  await input.blur();
  await saved;
  await expect(page.locator(".settings-saved")).toHaveText("saved ✓");

  await page.goto(`/settings?repo=${encodeURIComponent(session.repo)}`);
  await page.getByRole("tab", { name: "project · local" }).click();
  await expect(page.getByLabel("Summary lines")).toHaveValue("12");
  // The committed project value is untouched by the ·local save.
  await page.getByRole("tab", { name: "project", exact: true }).click();
  await expect(page.getByLabel("Summary lines")).toHaveValue("9");
});

test("sections lead with worktree, then notifications", async ({ page }) => {
  await page.goto("/settings");
  const titles = page.locator(".settings-section-title");
  await expect(titles.first()).toHaveText("worktree");
  await expect(titles.nth(1)).toHaveText("notifications");
});

test("worktree section carries both the worktree dir and the plans dir", async ({ page }) => {
  await page.goto("/settings");
  // Both storage-location knobs render, with worktree.dir leading plans.dir
  // under the single worktree heading (they can't share a storage section).
  const worktreeSection = page.locator(".settings-section", { hasText: "worktree" });
  await expect(worktreeSection.getByLabel("Worktree directory")).toBeVisible();
  await expect(worktreeSection.getByLabel("Plans directory")).toBeVisible();
  const labels = worktreeSection.locator(".field-name");
  await expect(labels.first()).toHaveText("Worktree directory");
  await expect(labels.nth(1)).toHaveText("Plans directory");
});

// The POST /api/config a save fires (used as a deterministic "the save landed"
// sync point so the reload-from-disk assertion can't run before it persisted).
const configPost = (page: import("@playwright/test").Page) =>
  page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/api/config"));

test("a text field auto-saves on blur (no Save button)", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("settings-autosave-text"));
  await page.goto(`/settings?repo=${encodeURIComponent(session.repo)}`);
  await page.getByRole("tab", { name: "project", exact: true }).click();

  // Editing IS the commit, with no Save button to click (or forget).
  await expect(page.getByRole("button", { name: "save" })).toHaveCount(0);

  const input = page.getByLabel("Summary lines");
  await input.fill("5");
  const saved = configPost(page);
  await input.blur();
  await saved;
  await expect(page.locator(".settings-saved")).toHaveText("saved ✓");

  // Reload from disk (Save was never clicked); the override stuck.
  await page.goto(`/settings?repo=${encodeURIComponent(session.repo)}`);
  await page.getByRole("tab", { name: "project", exact: true }).click();
  await expect(page.getByLabel("Summary lines")).toHaveValue("5");
});

test("a saved value survives a scope-tab switch without a reload", async ({ page, request }) => {
  // The bug: the save persisted to disk, but switching scope tabs and back (no
  // page reload) re-seeded ScopeFields from the values fetched on mount, so the
  // field reverted to its old value. The save now patches the cached scope, so
  // re-entering the tab re-seeds from the save. Worktree dir is the field hit.
  const session = await createSession(request, uniqueTitle("settings-tab-switch"));
  await page.goto(`/settings?repo=${encodeURIComponent(session.repo)}`);
  await page.getByRole("tab", { name: "project", exact: true }).click();

  const worktree = page.getByLabel("Worktree directory");
  await worktree.fill("build/worktrees");
  const saved = configPost(page);
  await worktree.blur();
  await saved;
  await expect(page.locator(".settings-saved")).toHaveText("saved ✓");

  // Leave the tab and come back — no page.goto, so this exercises the in-memory
  // cache, not a fresh fetch from disk. The just-saved value must still show.
  await page.getByRole("tab", { name: "user", exact: true }).click();
  await page.getByRole("tab", { name: "project", exact: true }).click();
  await expect(page.getByLabel("Worktree directory")).toHaveValue("build/worktrees");

  // And it really is on disk: a full reload reads it back too.
  await page.goto(`/settings?repo=${encodeURIComponent(session.repo)}`);
  await page.getByRole("tab", { name: "project", exact: true }).click();
  await expect(page.getByLabel("Worktree directory")).toHaveValue("build/worktrees");
});

test("a checkbox auto-saves the moment it toggles", async ({ page, request }) => {
  const session = await createSession(request, uniqueTitle("settings-autosave-bool"));
  await page.goto(`/settings?repo=${encodeURIComponent(session.repo)}`);
  await page.getByRole("tab", { name: "project", exact: true }).click();

  // Desktop notifications inherits the user scope's false here; checking it on is
  // its own commit, no blur needed.
  const saved = configPost(page);
  await page.getByLabel("Desktop notifications").check();
  await saved;
  await expect(page.locator(".settings-saved")).toHaveText("saved ✓");

  await page.goto(`/settings?repo=${encodeURIComponent(session.repo)}`);
  await page.getByRole("tab", { name: "project", exact: true }).click();
  await expect(page.getByLabel("Desktop notifications")).toBeChecked();
});
