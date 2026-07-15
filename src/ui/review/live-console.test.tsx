// The live console + now-playing model (the live-activity stream §10a): the
// folding (running→outcome pairing, run-collapsing), the kind filter + thinking
// toggle, the mode badge, and the now-playing label/timer selection. Tested
// against the pure model (console-model.ts), the same DOM-free split as
// group.test.ts, since the components are thin views over these functions and
// the repo carries no React test renderer.

import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "../api";
import {
  buildRows,
  isAgentActive,
  nowPlaying,
  pairOutcomes,
  streamMode,
} from "./console-model";

let seq = 0;
function reset(): void {
  seq = 0;
}

/** A captured tool call still running (no outcome yet). */
function running(label: string, tool: string, detail?: string): StreamEvent {
  return { seq: ++seq, at: iso(seq), kind: "tool", label, tool, status: "running", detail };
}
/** The follow-on outcome event the daemon appends for a running call. */
function outcome(status: "ok" | "error", label = `→ ${status}`): StreamEvent {
  return { seq: ++seq, at: iso(seq), kind: "tool", label, status };
}
function text(label: string): StreamEvent {
  return { seq: ++seq, at: iso(seq), kind: "text", label };
}
function thinking(label = "thinking…"): StreamEvent {
  return { seq: ++seq, at: iso(seq), kind: "thinking", label };
}
function highlight(label: string): StreamEvent {
  return { seq: ++seq, at: iso(seq), kind: "highlight", label };
}
/** A stable, increasing ISO so `at` ordering matches seq. */
function iso(n: number): string {
  return new Date(Date.UTC(2026, 5, 21, 0, 0, n)).toISOString();
}

describe("pairOutcomes", () => {
  test("folds a running tool call's outcome into it and drops the bare outcome", () => {
    reset();
    const events = [running("Bash: bun test", "Bash"), outcome("ok")];
    const paired = pairOutcomes(events);
    expect(paired).toHaveLength(1);
    expect(paired[0]?.status).toBe("ok");
    expect(paired[0]?.label).toBe("Bash: bun test");
  });

  test("matches a non-adjacent outcome across interleaved events (FIFO)", () => {
    reset();
    const r = running("Bash: sleep 5", "Bash");
    const events = [r, thinking(), text("meanwhile…"), outcome("error")];
    const paired = pairOutcomes(events);
    // thinking + text survive; the running call now carries the error status.
    expect(paired.map((e) => e.kind)).toEqual(["tool", "thinking", "text"]);
    const tool = paired.find((e) => e.kind === "tool");
    expect(tool?.status).toBe("error");
  });

  test("a running call with no outcome yet stays running", () => {
    reset();
    const paired = pairOutcomes([running("Read src/auth.ts", "Read")]);
    expect(paired[0]?.status).toBe("running");
  });

  test("resolves nested calls FIFO: first outcome settles the oldest open call", () => {
    reset();
    const events = [
      running("Read a", "Read"),
      running("Read b", "Read"),
      outcome("ok"), // → settles "Read a"
      outcome("error"), // → settles "Read b"
    ];
    const paired = pairOutcomes(events);
    expect(paired).toHaveLength(2);
    expect(paired[0]?.label).toBe("Read a");
    expect(paired[0]?.status).toBe("ok");
    expect(paired[1]?.label).toBe("Read b");
    expect(paired[1]?.status).toBe("error");
  });
});

describe("buildRows: run collapsing", () => {
  test("collapses a run of the same settled read into one counted row", () => {
    reset();
    const events: StreamEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(running("Read src/app.ts", "Read"), outcome("ok"));
    }
    const rows = buildRows(events, "all", false);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe("Read src/app.ts");
    expect(rows[0]?.members).toHaveLength(5);
    expect(rows[0]?.status).toBe("ok");
  });

  test("an interleaved different event splits the run", () => {
    reset();
    const events = [
      running("Read a", "Read"),
      outcome("ok"),
      running("Read a", "Read"),
      outcome("ok"),
      text("a note"),
      running("Read a", "Read"),
      outcome("ok"),
    ];
    const rows = buildRows(events, "all", false);
    // 2 reads · a text · 1 read → three rows
    expect(rows.map((r) => r.members.length)).toEqual([2, 1, 1]);
    expect(rows[1]?.kind).toBe("text");
  });

  test("a still-running tail never folds into a settled run (the bar must see it)", () => {
    reset();
    const events = [
      running("Read a", "Read"),
      outcome("ok"),
      running("Read a", "Read"), // no outcome yet
    ];
    const rows = buildRows(events, "all", false);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.status).toBe("running");
  });
});

describe("buildRows: thinking toggle + kind filter", () => {
  // The required behavioral assertion: a noisy stream of repeated reads plus
  // thinking collapses the repeats, hides thinking by default, and the kind
  // filter narrows the list.
  const noisy = (): StreamEvent[] => {
    reset();
    const events: StreamEvent[] = [];
    for (let i = 0; i < 4; i++) events.push(running("Read src/x.ts", "Read"), outcome("ok"));
    events.push(thinking("pondering the schema"));
    events.push(text("drafting the plan"));
    return events;
  };

  test("hides thinking when the toggle is off (default)", () => {
    const rows = buildRows(noisy(), "all", false);
    expect(rows.some((r) => r.kind === "thinking")).toBe(false);
    // the 4 reads collapse to one row; plus the text row
    expect(rows).toHaveLength(2);
    expect(rows[0]?.members).toHaveLength(4);
  });

  test("shows thinking when the toggle is on", () => {
    const rows = buildRows(noisy(), "all", true);
    expect(rows.some((r) => r.kind === "thinking")).toBe(true);
    expect(rows).toHaveLength(3);
  });

  test("the Tools filter narrows to tool rows only", () => {
    const rows = buildRows(noisy(), "tool", false);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("tool");
  });

  test("the Text filter narrows to text rows only", () => {
    const rows = buildRows(noisy(), "text", false);
    expect(rows.map((r) => r.kind)).toEqual(["text"]);
  });

  test("the Thinking filter shows thinking even with the toggle off", () => {
    // (the component passes showThinking=true for the thinking filter, but the
    // model still must surface thinking when the filter selects it)
    const rows = buildRows(noisy(), "thinking", true);
    expect(rows.map((r) => r.kind)).toEqual(["thinking"]);
  });

  test("highlights always pass the filter as their own un-collapsed rows", () => {
    reset();
    const events = [highlight("starting research"), running("Read a", "Read"), outcome("ok"), highlight("done reading")];
    const tools = buildRows(events, "tool", false);
    // even under the Tools filter the two highlights ride through
    expect(tools.filter((r) => r.kind === "highlight")).toHaveLength(2);
    expect(tools.filter((r) => r.kind === "tool")).toHaveLength(1);
  });

  test("two highlights in a row stay two distinct chapter rows", () => {
    reset();
    const rows = buildRows([highlight("note one"), highlight("note two")], "all", false);
    expect(rows).toHaveLength(2);
  });
});

describe("streamMode + isAgentActive", () => {
  test("notes mode when the stream is empty or only highlights", () => {
    reset();
    expect(streamMode([])).toBe("notes");
    expect(streamMode([highlight("a progress note")])).toBe("notes");
  });

  test("live mode once any captured (non-highlight) event lands", () => {
    reset();
    expect(streamMode([highlight("note"), text("captured text")])).toBe("live");
    expect(streamMode([running("Read a", "Read")])).toBe("live");
  });

  test("agent-active statuses pulse; resting states do not", () => {
    for (const s of ["draft", "revising", "finalizing", "implementing", "working"] as const) {
      expect(isAgentActive(s)).toBe(true);
    }
    for (const s of ["in_review", "approved", "implemented", "implement_failed", "reviewing", "done"] as const) {
      expect(isAgentActive(s)).toBe(false);
    }
  });
});

describe("nowPlaying", () => {
  // The required behavioral assertion: the latest event is a running Bash call →
  // the bar shows the command label, and the model flags it running (the bar
  // then renders a pulse via is-active + a ticking elapsed timer).
  test("a latest running Bash call yields its label, running=true, not dimmed", () => {
    reset();
    const events = [text("looking around"), running("Bash: bun test", "Bash")];
    const np = nowPlaying(events);
    expect(np?.event.label).toBe("Bash: bun test");
    expect(np?.running).toBe(true);
    expect(np?.dim).toBe(false);
  });

  test("returns null on an empty stream (the bar shows a resting line)", () => {
    reset();
    expect(nowPlaying([])).toBeNull();
  });

  test("prefers the most recent meaningful event over a trailing thinking", () => {
    reset();
    const events = [text("drafting the plan"), thinking(), thinking()];
    const np = nowPlaying(events);
    expect(np?.event.label).toBe("drafting the plan");
    expect(np?.dim).toBe(false);
    expect(np?.running).toBe(false);
  });

  test("falls back to the latest thinking (dimmed) when the whole tail is thinking", () => {
    reset();
    const np = nowPlaying([thinking("first"), thinking("second")]);
    expect(np?.event.label).toBe("second");
    expect(np?.dim).toBe(true);
  });

  test("a settled tool call is not flagged running", () => {
    reset();
    const np = nowPlaying([running("Read a", "Read"), outcome("ok")]);
    expect(np?.event.label).toBe("Read a");
    expect(np?.event.status).toBe("ok");
    expect(np?.running).toBe(false);
  });

  test("a highlight can be the now-playing line (manual note inline)", () => {
    reset();
    const np = nowPlaying([running("Read a", "Read"), outcome("ok"), highlight("checkpoint reached")]);
    expect(np?.event.kind).toBe("highlight");
    expect(np?.event.label).toBe("checkpoint reached");
  });
});
