import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VERSION } from "./version.js";

test("VERSION matches package.json", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
