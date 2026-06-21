import { describe, expect, test } from "bun:test";
import type { TranscriptAdapter, TranscriptHandle } from "./adapter.js";
import { ADAPTERS, findAdapter } from "./registry.js";

function fake(agent: string, locate: (repo: string) => TranscriptHandle | null): TranscriptAdapter {
  return {
    agent,
    locate,
    parse: (_handle, cursor) => ({ events: [], cursor }),
  };
}

describe("findAdapter", () => {
  test("the default registry includes the Claude adapter", () => {
    expect(ADAPTERS.map((a) => a.agent)).toContain("claude");
  });

  test("returns the first adapter whose locate matches", () => {
    const a = fake("a", () => null);
    const b = fake("b", (repo) => ({ agent: "b", path: `${repo}/b.jsonl` }));
    const c = fake("c", (repo) => ({ agent: "c", path: `${repo}/c.jsonl` }));
    const found = findAdapter("/repo", [a, b, c]);
    expect(found?.adapter.agent).toBe("b");
    expect(found?.handle.path).toBe("/repo/b.jsonl");
  });

  test("no adapter matches → null (the floor: no tailer attaches)", () => {
    const a = fake("a", () => null);
    const b = fake("b", () => null);
    expect(findAdapter("/repo", [a, b])).toBeNull();
  });

  test("a throwing locate is treated as no match, never propagated", () => {
    const boom = fake("boom", () => {
      throw new Error("adapter blew up");
    });
    const ok = fake("ok", (repo) => ({ agent: "ok", path: `${repo}/ok.jsonl` }));
    const found = findAdapter("/repo", [boom, ok]);
    expect(found?.adapter.agent).toBe("ok");
  });
});
