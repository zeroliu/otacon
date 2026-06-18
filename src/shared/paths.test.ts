import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homeSessionDir, homeSessionsDir } from "./paths.js";

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
