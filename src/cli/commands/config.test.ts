// otacon config get <key> — read-only merged lookup against config files, no
// daemon. OTACON_HOME points loadConfig's user layer at a temp config.json; the
// process runs from a non-repo cwd (tmpdir) so there is no project overlay. We
// assert the printed JSON line and the CliError exit codes (unknown key → 1,
// missing/extra arg → 2, unknown sub-form → 2). The `config open` form spawns
// the daemon, so its URL shape is covered by the end-to-end build check instead.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../output.js";
import { configCommand } from "./config.js";

let home: string;
let cwd: string;
let savedHome: string | undefined;
let savedCwd: string;
let out: string[];
let writeSpy: typeof process.stdout.write;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "otacon-cfg-home-")));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "otacon-cfg-cwd-")));
  savedHome = process.env.OTACON_HOME;
  process.env.OTACON_HOME = home;
  savedCwd = process.cwd();
  process.chdir(cwd); // a bare tmpdir is outside any git repo
  out = [];
  writeSpy = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = writeSpy;
  process.chdir(savedCwd);
  if (savedHome === undefined) delete process.env.OTACON_HOME;
  else process.env.OTACON_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const printed = () => JSON.parse(out.join("").trim()) as Record<string, unknown>;

test("config get returns the merged value (user overlay over defaults)", async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ budgets: { summaryLines: 9 } }));
  const code = await configCommand(["get", "budgets.summaryLines"]);
  expect(code).toBe(0);
  expect(printed()).toEqual({ ok: true, key: "budgets.summaryLines", value: 9 });
});

test("config get falls back to the default when no file overrides it", async () => {
  const code = await configCommand(["get", "worktree.dir"]);
  expect(code).toBe(0);
  expect(printed()).toEqual({ ok: true, key: "worktree.dir", value: ".otacon/worktrees" });
});

test("config get on an unknown key fails E_UNKNOWN_KEY (exit 1)", async () => {
  expect(configCommand(["get", "bogus.key"])).rejects.toMatchObject({
    code: "E_UNKNOWN_KEY",
    exitCode: 1,
  } satisfies Partial<CliError>);
});

test("config get with no key is a usage error (exit 2)", async () => {
  expect(configCommand(["get"])).rejects.toMatchObject({ code: "E_USAGE", exitCode: 2 });
});

test("config get with an extra positional is a usage error (exit 2)", async () => {
  expect(configCommand(["get", "worktree.dir", "extra"])).rejects.toMatchObject({
    code: "E_USAGE",
    exitCode: 2,
  });
});

test("an unknown sub-form is a usage error (exit 2)", async () => {
  expect(configCommand(["frobnicate"])).rejects.toMatchObject({ code: "E_USAGE", exitCode: 2 });
});
