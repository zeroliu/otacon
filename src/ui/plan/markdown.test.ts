import { describe, expect, test } from "bun:test";
import { marked } from "./marked-setup.js";

function render(src: string): string {
  return marked.parse(src, { async: false }) as string;
}

describe("decision matrix rendering", () => {
  test("a row whose first cell is ✓ gets the chosen class; others don't", () => {
    const html = render("| Pick | Option |\n| --- | --- |\n| ✓ | RS256 |\n| | HS256 |\n");
    expect(html).toContain('<tr class="chosen">');
    expect(html).toContain("RS256");
    // Exactly one chosen row — never the header, never the unmarked row.
    expect(html.match(/class="chosen"/g)).toHaveLength(1);
  });

  test("a table with no ✓ row degrades to a plain table", () => {
    const html = render("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    expect(html).not.toContain('class="chosen"');
  });
});

describe("callout rendering through the configured marked", () => {
  test("a typed blockquote becomes a callout panel", () => {
    const html = render("> [!risk]\n> Migrating locks out old sessions.\n");
    expect(html).toContain('<div class="callout callout-risk">');
    expect(html).toContain("Migrating locks out old sessions.");
  });

  test("a plain blockquote falls back to a blockquote", () => {
    const html = render("> just a quote\n");
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("callout");
  });
});

describe("inline scope pills", () => {
  test("every known bracket token becomes a pill span", () => {
    const html = render("touches [new], is [breaking], [risky], and [deletes] code");
    expect(html).toContain('<span class="pill pill-new">new</span>');
    expect(html).toContain('<span class="pill pill-breaking">breaking</span>');
    expect(html).toContain('<span class="pill pill-risky">risky</span>');
    expect(html).toContain('<span class="pill pill-deletes">deletes</span>');
  });

  test("markdown links are left alone, not turned into pills", () => {
    const html = render("see [new](https://example.com/new) for details");
    expect(html).toContain('href="https://example.com/new"');
    expect(html).not.toContain('class="pill');
  });

  test("[assumed] is left untouched (it is the decision-trace tag, not a pill)", () => {
    const html = render("decided [assumed] without asking");
    expect(html).toContain("[assumed]");
    expect(html).not.toContain('class="pill');
  });

  test("unknown bracket tokens stay literal text", () => {
    expect(render("a [todo] note")).not.toContain('class="pill');
  });
});
