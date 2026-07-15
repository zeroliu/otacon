// otacon knowledge get|put --scope user|project [--repo <root>]
//
// A JSON-line bridge for agents that cannot write ~/.otacon directly. Project
// scope derives canonical GitHub owner/repo identity from the clone's origin;
// local clone paths never become storage keys. PUT reads Markdown from --file
// and uses --base-hash for optimistic concurrency.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { canonicalizeGitHubRepo } from "../../shared/knowledge.js";
import type { CanonicalGitHubRepo, KnowledgeScope } from "../../shared/knowledge.js";
import { api, ensureDaemon } from "../client.js";
import type { ApiResponse } from "../client.js";
import { fail, printJson, usageError } from "../output.js";
import { findRepoRoot, realpathOr } from "../session.js";

export interface KnowledgeCommandDeps {
  ensureDaemon(): Promise<unknown>;
  api(method: string, path: string, body?: unknown): Promise<ApiResponse>;
  readFile(path: string): string;
  cwd(): string;
  projectIdentity(repoArgument: string | undefined, cwd: string): CanonicalGitHubRepo | undefined;
}

function defaultProjectIdentity(repoArgument: string | undefined, cwd: string): CanonicalGitHubRepo | undefined {
  const start = repoArgument === undefined ? cwd : resolve(cwd, repoArgument);
  const root = findRepoRoot(realpathOr(start));
  if (root === undefined) return undefined;
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return canonicalizeGitHubRepo(remote);
  } catch {
    return undefined;
  }
}

const DEFAULT_DEPS: KnowledgeCommandDeps = {
  ensureDaemon,
  api,
  readFile: (path) => readFileSync(path, "utf8"),
  cwd: () => process.cwd(),
  projectIdentity: defaultProjectIdentity,
};

function query(scope: KnowledgeScope, repo: CanonicalGitHubRepo | undefined): string {
  const params = new URLSearchParams({ scope });
  if (repo !== undefined) params.set("repo", repo);
  return `/api/knowledge?${params.toString()}`;
}

function message(response: ApiResponse): string {
  return (response.body.error as { message?: string } | undefined)?.message ?? JSON.stringify(response.body);
}

export async function knowledgeCommand(
  argv: string[],
  deps: KnowledgeCommandDeps = DEFAULT_DEPS,
): Promise<number> {
  const sub = argv[0];
  if (sub !== "get" && sub !== "put") {
    usageError("usage: otacon knowledge get|put --scope user|project [--repo <root>] [--file <markdown> --base-hash <hash>]");
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      scope: { type: "string" },
      repo: { type: "string" },
      file: { type: "string" },
      "base-hash": { type: "string" },
    },
  });
  if (values.scope !== "user" && values.scope !== "project") {
    usageError('knowledge requires --scope "user" or "project"');
  }
  const scope = values.scope as KnowledgeScope;
  const repo = scope === "project"
    ? deps.projectIdentity(values.repo, realpathOr(deps.cwd()))
    : undefined;
  if (scope === "project" && repo === undefined) {
    fail(
      "E_GITHUB_REPO",
      "project knowledge requires a git repository whose origin is a GitHub owner/repo",
    );
  }
  if (sub === "get" && (values.file !== undefined || values["base-hash"] !== undefined)) {
    usageError("knowledge get does not accept --file or --base-hash");
  }
  if (sub === "put" && (values.file === undefined || values["base-hash"] === undefined)) {
    usageError("knowledge put requires --file <markdown> and --base-hash <hash>");
  }

  let markdown: string | undefined;
  if (sub === "put") {
    try {
      markdown = deps.readFile(resolve(deps.cwd(), values.file!));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail("E_FILE", `cannot read knowledge Markdown ${values.file}: ${detail}`);
    }
  }

  await deps.ensureDaemon();
  const response = sub === "get"
    ? await deps.api("GET", query(scope, repo))
    : await deps.api("PUT", "/api/knowledge", {
      scope,
      ...(repo === undefined ? {} : { repo }),
      markdown,
      baseHash: values["base-hash"],
    });
  if (response.status === 200) {
    printJson({ ok: true, ...response.body });
    return 0;
  }
  const code = (response.body.error as { code?: string } | undefined)?.code;
  if (response.status === 409) {
    fail(code ?? "E_KNOWLEDGE_CONFLICT", message(response), {
      document: response.body.document,
    });
  }
  if (response.status === 400 || response.status === 422) {
    fail(code ?? "E_BAD_REQUEST", message(response));
  }
  fail("E_INTERNAL", `knowledge ${sub} failed: ${JSON.stringify(response.body)}`, undefined, 2);
}
