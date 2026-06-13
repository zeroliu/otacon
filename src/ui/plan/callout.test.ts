import { describe, expect, test } from "bun:test";
import { calloutHtml } from "./callout.js";

describe("calloutHtml", () => {
  test("renders each known type with its class, glyph, and label", () => {
    const risk = calloutHtml("[!risk]\nThe migration locks out old sessions.")!;
    expect(risk).toContain('<div class="callout callout-risk">');
    expect(risk).toContain('<p class="callout-label">▲ Risk</p>');

    expect(calloutHtml("[!note]\nx")).toContain('<p class="callout-label">● Note</p>');
    expect(calloutHtml("[!decision]\nx")).toContain('<p class="callout-label">◆ Decision</p>');
    expect(calloutHtml("[!assumption]\nx")).toContain(
      '<p class="callout-label">◇ Assumption</p>',
    );
  });

  test("the body is re-rendered as markdown inside callout-body", () => {
    const html = calloutHtml("[!risk]\nThe migration **locks out** sessions.")!;
    expect(html).toContain('<div class="callout-body">');
    expect(html).toContain("<strong>locks out</strong>");
  });

  test("marker is case-insensitive and the body can be multi-line markdown", () => {
    const html = calloutHtml("[!NOTE]\n- one\n- two")!;
    expect(html).toContain("callout-note");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  test("a marker with no body still renders an empty body panel", () => {
    const html = calloutHtml("[!decision]")!;
    expect(html).toBe(
      '<div class="callout callout-decision"><p class="callout-label">◆ Decision</p><div class="callout-body"></div></div>',
    );
  });

  test("unknown types and non-marker first lines fall back (null)", () => {
    expect(calloutHtml("[!warning]\nnot in the closed set")).toBeNull();
    expect(calloutHtml("Just a normal quote.\nSecond line.")).toBeNull();
    expect(calloutHtml("[!risk] inline, not its own line")).toBeNull();
    expect(calloutHtml("")).toBeNull();
  });
});
