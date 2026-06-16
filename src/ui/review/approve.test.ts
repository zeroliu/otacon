import { describe, expect, test } from "bun:test";
import type { ApproveResult } from "../api.js";
import { approveMove } from "./approve.js";

// approveMove is the pure translation both the direct fire and the drafts
// "Send & commit" flush-then-fold path share — every UI branch (close, defer,
// warn, error) is decided here, so it carries the dialog's whole control flow.
describe("approveMove", () => {
  test("a finalize-now success carries the artifact path through to approved", () => {
    const result: ApproveResult = { ok: true, path: "docs/plans/r3.md", revision: 3 };
    expect(approveMove(result, false)).toEqual({ kind: "approved", path: "docs/plans/r3.md" });
  });

  test("a deferred (comment & approve) success becomes finalizing — the SSE frame drives", () => {
    const result: ApproveResult = { ok: true, finalizing: true };
    expect(approveMove(result, false)).toEqual({ kind: "finalizing" });
  });

  test("E_UNRESOLVED_THREADS without force bounces to the warn stage with both counts", () => {
    const result: ApproveResult = {
      ok: false,
      code: "E_UNRESOLVED_THREADS",
      unresolved: 2,
      openComments: 1,
    };
    expect(approveMove(result, false)).toEqual({ kind: "warn", unresolved: 2, openComments: 1 });
  });

  test("a Send-to-agent retry that lost its race warns with openComments defaulting to 0", () => {
    const result: ApproveResult = { ok: false, code: "E_UNRESOLVED_THREADS", unresolved: 1 };
    expect(approveMove(result, false)).toEqual({ kind: "warn", unresolved: 1, openComments: 0 });
  });

  test("a force commit never re-warns on unresolved threads — its 409 surfaces as an error", () => {
    const result: ApproveResult = {
      ok: false,
      code: "E_UNRESOLVED_THREADS",
      message: "still 2 open",
      unresolved: 2,
    };
    expect(approveMove(result, true)).toEqual({ kind: "error", message: "still 2 open" });
  });

  test("an unreachable daemon gets the friendly is-it-up copy, not a raw code", () => {
    const result: ApproveResult = { ok: false, code: "E_UNREACHABLE" };
    const move = approveMove(result, false);
    expect(move.kind).toBe("error");
    expect(move).toHaveProperty("message");
    if (move.kind === "error") expect(move.message).toContain("otacond");
  });

  test("any other failure surfaces its message, falling back to the bare code", () => {
    expect(approveMove({ ok: false, code: "E_INTERNAL", message: "boom" }, false)).toEqual({
      kind: "error",
      message: "boom",
    });
    expect(approveMove({ ok: false, code: "E_WEIRD" }, false)).toEqual({
      kind: "error",
      message: "E_WEIRD",
    });
  });
});
