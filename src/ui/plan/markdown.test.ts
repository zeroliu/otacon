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
