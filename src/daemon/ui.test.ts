import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBuiltUiDir } from "./ui.js";

// Regression for the blank-page bug (commit fac1349 moved ui/ under src/ui/):
// a source run must serve the built dist/ui, never the source src/ui/ — whose
// index.html is the Vite dev template referencing /main.tsx, which the daemon
// can't serve, so nothing renders. The `assets/` sibling is the discriminator.
describe("isBuiltUiDir", () => {
  const make = (shape: "build" | "source-template" | "empty"): string => {
    const dir = mkdtempSync(join(tmpdir(), "otacon-ui-"));
    if (shape !== "empty") writeFileSync(join(dir, "index.html"), "<!doctype html>");
    if (shape === "build") mkdirSync(join(dir, "assets"));
    return dir;
  };

  test("accepts a real build: index.html + assets/", () => {
    expect(isBuiltUiDir(make("build"))).toBe(true);
  });

  test("rejects the source dev template: index.html, no assets/", () => {
    expect(isBuiltUiDir(make("source-template"))).toBe(false);
  });

  test("rejects a dir with neither", () => {
    expect(isBuiltUiDir(make("empty"))).toBe(false);
  });
});
