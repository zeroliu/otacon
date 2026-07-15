import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  activityPath,
  eventsPath,
  expandTilde,
  homeSessionDir,
  homeSessionsDir,
  knowledgeDir,
  planPath,
  projectKnowledgeDir,
  projectKnowledgeEvidencePath,
  projectKnowledgePath,
  revisionChangelogPath,
  revisionPath,
  revisionWarningsPath,
  sessionDir,
  sessionStatePath,
  streamPath,
  threadsPath,
  transcriptPath,
  updateCachePath,
  userKnowledgeEvidencePath,
  userKnowledgePath,
} from "./paths.js";
import { canonicalizeGitHubRepo } from "./knowledge.js";

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

describe("implicit-profile knowledge paths", () => {
  const repo = canonicalizeGitHubRepo("Acme/App");
  if (repo === undefined) throw new Error("fixture repo should canonicalize");

  test("user knowledge stays directly under the home knowledge root", () => {
    expect(knowledgeDir()).toBe(join("/tmp/otacon-home-test", "knowledge"));
    expect(userKnowledgePath()).toBe(join(knowledgeDir(), "user.md"));
    expect(userKnowledgeEvidencePath()).toBe(join(knowledgeDir(), "user.evidence.jsonl"));
  });

  test("project knowledge is keyed by canonical GitHub owner/repo", () => {
    expect(projectKnowledgeDir(repo)).toBe(
      join(knowledgeDir(), "projects", "github.com", "acme", "app"),
    );
    expect(projectKnowledgePath(repo)).toBe(join(projectKnowledgeDir(repo), "knowledge.md"));
    expect(projectKnowledgeEvidencePath(repo)).toBe(join(projectKnowledgeDir(repo), "evidence.jsonl"));
  });
});

describe("per-session working state lives in the home store", () => {
  // After confine-otacon-dir-to-config-and-plans, the per-session helpers take
  // the session id only (no repo root) and resolve under
  // <OTACON_HOME>/sessions/<id>/, equal to homeSessionDir(id).
  const id = "otc_a1b2c3";
  const dir = join("/tmp/otacon-home-test", "sessions", id);

  test("sessionDir is the home session dir (id only, no repo root)", () => {
    expect(sessionDir(id)).toBe(dir);
    expect(sessionDir(id)).toBe(homeSessionDir(id));
  });

  test("every per-session file nests under the home session dir", () => {
    expect(planPath(id)).toBe(join(dir, "plan.md"));
    expect(sessionStatePath(id)).toBe(join(dir, "session.json"));
    expect(eventsPath(id)).toBe(join(dir, "events.json"));
    expect(threadsPath(id)).toBe(join(dir, "threads.json"));
    expect(transcriptPath(id)).toBe(join(dir, "transcript.json"));
    expect(activityPath(id)).toBe(join(dir, "activity.json"));
    expect(streamPath(id)).toBe(join(dir, "stream.jsonl"));
    expect(revisionPath(id, 2)).toBe(join(dir, "r2.md"));
    expect(revisionWarningsPath(id, 2)).toBe(join(dir, "r2.warnings.json"));
    expect(revisionChangelogPath(id, 2)).toBe(join(dir, "r2.changelog.md"));
  });

  test("no per-session path touches the repo root", () => {
    process.env.OTACON_HOME = "/tmp/otacon-home-test";
    const repoRoot = "/some/repo";
    for (const p of [
      sessionDir(id),
      planPath(id),
      sessionStatePath(id),
      eventsPath(id),
      threadsPath(id),
      transcriptPath(id),
      activityPath(id),
      streamPath(id),
      revisionPath(id, 1),
      revisionWarningsPath(id, 1),
      revisionChangelogPath(id, 1),
    ]) {
      expect(p.startsWith(join("/tmp/otacon-home-test", "sessions"))).toBe(true);
      expect(p.includes(repoRoot)).toBe(false);
      expect(p.includes(".otacon")).toBe(false);
    }
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
