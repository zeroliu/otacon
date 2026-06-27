import { describe, expect, test } from "bun:test";
import { fetchPrState } from "./pr-status.js";

const URL = "https://github.com/acme/widgets/pull/42";

/** A fake `run` that resolves the given gh stdout (no real process spawn). */
function ok(stdout: string): { run: (args: string[]) => Promise<string> } {
  return { run: () => Promise.resolve(stdout) };
}

/** A fake `run` that rejects, simulating gh missing / non-zero exit / network error. */
function fail(message: string): { run: (args: string[]) => Promise<string> } {
  return { run: () => Promise.reject(new Error(message)) };
}

describe("fetchPrState", () => {
  test('maps {"state":"OPEN"} → "open"', async () => {
    expect(await fetchPrState(URL, ok('{"state":"OPEN"}'))).toBe("open");
  });

  test('maps {"state":"MERGED"} → "merged"', async () => {
    expect(await fetchPrState(URL, ok('{"state":"MERGED"}'))).toBe("merged");
  });

  test('maps {"state":"CLOSED"} → "closed"', async () => {
    expect(await fetchPrState(URL, ok('{"state":"CLOSED"}'))).toBe("closed");
  });

  test("passes the expected gh argv to run", async () => {
    let seen: string[] | undefined;
    await fetchPrState(URL, {
      run: (args) => {
        seen = args;
        return Promise.resolve('{"state":"OPEN"}');
      },
    });
    expect(seen).toEqual(["pr", "view", URL, "--json", "state"]);
  });

  test("returns undefined when run rejects (gh missing / non-zero exit)", async () => {
    expect(await fetchPrState(URL, fail("spawn gh ENOENT"))).toBeUndefined();
  });

  test("returns undefined on malformed JSON", async () => {
    expect(await fetchPrState(URL, ok("not json at all"))).toBeUndefined();
  });

  test("returns undefined on empty stdout", async () => {
    expect(await fetchPrState(URL, ok(""))).toBeUndefined();
  });

  test("returns undefined on an unexpected/unknown state value", async () => {
    expect(await fetchPrState(URL, ok('{"state":"DRAFT"}'))).toBeUndefined();
  });

  test("returns undefined when the state field is absent", async () => {
    expect(await fetchPrState(URL, ok('{"number":42}'))).toBeUndefined();
  });
});
