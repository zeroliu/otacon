import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGitignore } from "./start.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "otacon-start-")));
  path = join(dir, ".gitignore");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => readFileSync(path, "utf8");

describe("ensureGitignore", () => {
  test("creates .gitignore when missing", () => {
    ensureGitignore(dir);
    expect(read()).toBe(".otacon/\n");
  });

  test("appends without clobbering existing content", () => {
    writeFileSync(path, "node_modules/\ndist/\n");
    ensureGitignore(dir);
    expect(read()).toBe("node_modules/\ndist/\n.otacon/\n");
  });

  test("adds a separating newline when the file lacks a trailing one", () => {
    writeFileSync(path, "node_modules/");
    ensureGitignore(dir);
    expect(read()).toBe("node_modules/\n.otacon/\n");
  });

  test.each([".otacon/", ".otacon", "/.otacon/", "  .otacon/  ", ".otacon/\r"])(
    "is idempotent when already covered as %j",
    (line) => {
      writeFileSync(path, `node_modules/\n${line}\n`);
      ensureGitignore(dir);
      expect(read()).toBe(`node_modules/\n${line}\n`);
    },
  );

  test("running twice never duplicates the entry", () => {
    ensureGitignore(dir);
    ensureGitignore(dir);
    expect(read()).toBe(".otacon/\n");
  });

  test("a commented-out entry does not count as covered", () => {
    writeFileSync(path, "# .otacon/\n");
    ensureGitignore(dir);
    expect(read()).toBe("# .otacon/\n.otacon/\n");
  });

  test("a CRLF file gets a CRLF append, not mixed endings", () => {
    writeFileSync(path, "node_modules/\r\ndist/\r\n");
    ensureGitignore(dir);
    expect(read()).toBe("node_modules/\r\ndist/\r\n.otacon/\r\n");
  });

  test("a CRLF file without a trailing newline gets a CRLF separator", () => {
    writeFileSync(path, "node_modules/\r\ndist/");
    ensureGitignore(dir);
    expect(read()).toBe("node_modules/\r\ndist/\r\n.otacon/\r\n");
  });
});
