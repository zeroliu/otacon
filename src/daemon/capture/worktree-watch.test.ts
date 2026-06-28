import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKTREE_POLL_MS, scanNewestMtime, WorktreeWatch } from "./worktree-watch.js";

/** Build a watch with an injected scan and no real timer; drive `tick()`. */
function harness(opts: { scan: (dir: string) => number | undefined }) {
  let bumps = 0;
  const watch = new WorktreeWatch({
    dir: "/worktree",
    onActivity: () => {
      bumps += 1;
    },
    scan: opts.scan,
    // No real timer: the test drives `tick()` by hand.
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => {},
  });
  return { watch, bumps: () => bumps };
}

describe("WorktreeWatch baseline + bump logic", () => {
  test("the first tick establishes a baseline and does NOT call onActivity", () => {
    const { watch, bumps } = harness({ scan: () => 1000 });
    watch.start();
    watch.tick();
    expect(bumps()).toBe(0);
  });

  test("a later tick with a greater mtime calls onActivity and re-baselines", () => {
    let mtime = 1000;
    const { watch, bumps } = harness({ scan: () => mtime });
    watch.start();
    watch.tick(); // baseline = 1000, no bump
    mtime = 2000;
    watch.tick(); // greater → bump, baseline = 2000
    expect(bumps()).toBe(1);
    // Re-baselined: a tick at the same 2000 must not bump again.
    watch.tick();
    expect(bumps()).toBe(1);
    mtime = 3000;
    watch.tick(); // greater again → bump
    expect(bumps()).toBe(2);
  });

  test("a tick with an equal or lower mtime does NOT call onActivity", () => {
    let mtime = 5000;
    const { watch, bumps } = harness({ scan: () => mtime });
    watch.start();
    watch.tick(); // baseline = 5000
    mtime = 5000;
    watch.tick(); // equal → no bump
    expect(bumps()).toBe(0);
    mtime = 4000;
    watch.tick(); // lower → no bump
    expect(bumps()).toBe(0);
  });

  test("a not-yet-created dir (scan undefined) never bumps, then works once it appears", () => {
    let mtime: number | undefined; // dir doesn't exist yet
    const { watch, bumps } = harness({ scan: () => mtime });
    watch.start();
    watch.tick(); // undefined → no baseline, no bump
    watch.tick(); // still undefined → keep polling, no bump
    expect(bumps()).toBe(0);
    mtime = 1000; // worktree appears
    watch.tick(); // first real reading → baseline only, no bump
    expect(bumps()).toBe(0);
    mtime = 2000;
    watch.tick(); // greater → bump
    expect(bumps()).toBe(1);
  });

  test("start and stop are idempotent", () => {
    let starts = 0;
    let stops = 0;
    const watch = new WorktreeWatch({
      dir: "/worktree",
      onActivity: () => {},
      scan: () => 1000,
      setInterval: () => {
        starts += 1;
        return 0 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        stops += 1;
      },
    });
    watch.start();
    watch.start(); // second start is a no-op
    expect(starts).toBe(1);
    watch.stop();
    watch.stop(); // second stop is a no-op
    expect(stops).toBe(1);
  });

  test("a throwing scan is swallowed (fail-soft) and the loop survives", () => {
    let mode: "throw" | number = "throw";
    const { watch, bumps } = harness({
      scan: () => {
        if (mode === "throw") throw new Error("scan blew up");
        return mode;
      },
    });
    watch.start();
    expect(() => watch.tick()).not.toThrow(); // swallowed, no baseline
    expect(bumps()).toBe(0);
    // Recover: a real reading after the throw still primes + bumps normally.
    mode = 1000;
    watch.tick(); // baseline
    mode = 2000;
    watch.tick(); // bump
    expect(bumps()).toBe(1);
  });

  test("the default poll cadence stays below the 5-min agentLive window", () => {
    expect(DEFAULT_WORKTREE_POLL_MS).toBeLessThan(5 * 60_000);
  });
});

describe("scanNewestMtime over a real temp dir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otacon-wtwatch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns undefined for a dir that does not exist", () => {
    expect(scanNewestMtime(join(dir, "nope"))).toBeUndefined();
  });

  test("returns a number reflecting a written file's mtime", () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    const newest = scanNewestMtime(dir);
    expect(typeof newest).toBe("number");
    expect(newest).toBeGreaterThan(0);
  });

  test("excludes node_modules even when it holds a newer file", () => {
    const file = join(dir, "src.ts");
    writeFileSync(file, "code");

    const nm = join(dir, "node_modules");
    mkdirSync(nm);
    const dep = join(nm, "dep.js");
    writeFileSync(dep, "dep");

    // Pin every scanned-and-skipped entry to known times AFTER all writes (which
    // bump parent-dir mtimes). The tracked file is older; the excluded
    // node_modules subtree is far newer. The root dir is pinned old too so only
    // explicit mtimes decide the result.
    const newer = new Date("2030-01-01T00:00:00Z").getTime() / 1000;
    const older = new Date("2020-01-01T00:00:00Z").getTime() / 1000;
    utimesSync(dep, newer, newer);
    utimesSync(nm, newer, newer);
    utimesSync(file, older, older);
    utimesSync(dir, older, older);

    const newest = scanNewestMtime(dir);
    expect(typeof newest).toBe("number");
    // The far-newer node_modules subtree is excluded, so the older tracked file
    // (and root dir) win — the result must be the older time, not 2030.
    expect(newest).toBe(older * 1000);
    expect(newest).toBeLessThan(newer * 1000);
  });

  test("excludes .git even when it holds a newer file", () => {
    const file = join(dir, "src.ts");
    writeFileSync(file, "code");

    const gitDir = join(dir, ".git");
    mkdirSync(gitDir);
    const head = join(gitDir, "HEAD");
    writeFileSync(head, "ref: refs/heads/main");

    // Same pinning strategy as the node_modules case: the excluded .git subtree
    // is far newer, the tracked file and root are pinned old, so only explicit
    // mtimes decide the result.
    const newer = new Date("2030-01-01T00:00:00Z").getTime() / 1000;
    const older = new Date("2020-01-01T00:00:00Z").getTime() / 1000;
    utimesSync(head, newer, newer);
    utimesSync(gitDir, newer, newer);
    utimesSync(file, older, older);
    utimesSync(dir, older, older);

    const newest = scanNewestMtime(dir);
    expect(typeof newest).toBe("number");
    // The far-newer .git subtree is excluded, so the older tracked file wins.
    expect(newest).toBe(older * 1000);
    expect(newest).toBeLessThan(newer * 1000);
  });
});
