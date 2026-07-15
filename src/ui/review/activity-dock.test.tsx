import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityDock } from "./activity-dock.js";

describe("ActivityDock", () => {
  test("shows a resting log for PR review before the first event", () => {
    const html = renderToStaticMarkup(
      <ActivityDock stream={[]} status="reviewing" now={0} alwaysVisible />,
    );
    expect(html).toContain("agent activity: toggle the live console");
    expect(html).toContain("idle");
    expect(html).toContain("notes");
  });

  test("working review authoring is active before the first event", () => {
    const html = renderToStaticMarkup(<ActivityDock stream={[]} status="working" now={0} />);
    expect(html).toContain("working…");
    expect(html).toContain("is-active");
  });

  test("an idle plan-style dock with no history stays absent", () => {
    expect(renderToStaticMarkup(
      <ActivityDock stream={[]} status="in_review" now={0} />,
    )).toBe("");
  });
});
