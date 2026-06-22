import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandTilde, homeSessionDir, homeSessionsDir, updateCachePath } from "./paths.js";

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.OTACON_HOME;
  process.env.OTACON_HOME = "/tmp/otacon-home-test";
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
});

describe("home plan archive paths", () => {
  test("homeSessionsDir is <OTACON_HOME>/sessions", () => {
    expect(homeSessionsDir()).toBe(join("/tmp/otacon-home-test", "sessions"));
  });

  test("homeSessionDir nests the session id under the sessions root", () => {
    expect(homeSessionDir("otc_a1b2c3")).toBe(
      join("/tmp/otacon-home-test", "sessions", "otc_a1b2c3"),
    );
  });

  test("OTACON_HOME is read at call time, so a later override takes effect", () => {
    process.env.OTACON_HOME = "/tmp/otacon-other";
    expect(homeSessionsDir()).toBe(join("/tmp/otacon-other", "sessions"));
    expect(homeSessionDir("otc_zzz")).toBe(join("/tmp/otacon-other", "sessions", "otc_zzz"));
  });
});

describe("expandTilde", () => {
  test("bare ~ expands to the home dir", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  test("~/x joins the rest onto the home dir", () => {
    expect(expandTilde("~/.otacon/worktrees")).toBe(join(homedir(), ".otacon", "worktrees"));
  });

  test("an absolute path is returned unchanged", () => {
    expect(expandTilde("/var/tmp/build")).toBe("/var/tmp/build");
  });

  test("a path with ~ not at the start is left alone", () => {
    expect(expandTilde("/home/~user")).toBe("/home/~user");
    expect(expandTilde("relative/path")).toBe("relative/path");
  });
});

describe("update check cache path", () => {
  test("updateCachePath is <OTACON_HOME>/update-check.json", () => {
    expect(updateCachePath()).toBe(join("/tmp/otacon-home-test", "update-check.json"));
  });

  test("OTACON_HOME is read at call time for the cache path too", () => {
    process.env.OTACON_HOME = "/tmp/otacon-other";
    expect(updateCachePath()).toBe(join("/tmp/otacon-other", "update-check.json"));
  });
});
