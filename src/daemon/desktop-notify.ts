// Native macOS desktop banners for "this plan needs your attention". The daemon
// already runs on the Mac, so it fires the banner directly rather than over Web
// Push (phone is a deferred path). Prefers
// `terminal-notifier` when on PATH (its banner is clickable — tapping opens the
// review URL), falls back to `osascript` (zero dependency, not clickable); a
// no-op off macOS. These are LOCAL OS calls, never a model API — the
// zero-API-spend invariant is untouched.

import { execFile, execFileSync } from "node:child_process";

/** What to show: a session title, the attention message, and (optional) the review URL. */
export interface DesktopNotification {
  title: string;
  message: string;
  /** terminal-notifier opens this on click; osascript ignores it (no click target). */
  url?: string;
}

/** The spawn seam: tests pass a recorder to assert (bin, args) without firing a banner. */
export type SpawnFn = (bin: string, args: string[]) => void;

/** A fire-and-forget desktop notification sink. */
export type DesktopNotifier = (notification: DesktopNotification) => void;

export interface NotifierOptions {
  /** Defaults to `process.platform`; tests pin it to exercise the off-darwin no-op. */
  platform?: string;
  /** Defaults to `findTerminalNotifier`; tests force the tool-selection branch. */
  findNotifier?: () => string | undefined;
  /** Defaults to a detached `execFile`; tests capture the chosen binary + args. */
  spawn?: SpawnFn;
}

/**
 * Locate `terminal-notifier`: `$OTACON_TERMINAL_NOTIFIER` pins the binary
 * (hermetic tests; nonstandard installs) and is authoritative when set,
 * otherwise PATH (mirrors `findTailscale` in src/cli/install/tailscale.ts).
 * Returns undefined when it is not callable — the caller falls back to osascript.
 */
export function findTerminalNotifier(): string | undefined {
  const override = process.env.OTACON_TERMINAL_NOTIFIER;
  const candidates = override !== undefined && override !== "" ? [override] : ["terminal-notifier"];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["-help"], { stdio: ["ignore", "ignore", "ignore"] });
      return bin;
    } catch {
      // not this one
    }
  }
  return undefined;
}

/** Detached, output-ignored, error-swallowed: a banner must never block or break a response. */
const defaultSpawn: SpawnFn = (bin, args) => {
  execFile(bin, args, () => undefined);
};

/**
 * Quote a string into an AppleScript double-quoted literal. The whole script
 * is one `-e` argv element (no shell — see notify below), so the only consumer
 * is osascript's AppleScript parser; escaping backslash and double-quote is the
 * entire injection surface.
 */
function osaQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build a notify function. Every call goes through `execFile` with an **arg
 * array** (no shell), so a session title or question text can never inject. On
 * a non-darwin platform it is a no-op; with terminal-notifier present and a
 * url, the banner is clickable; otherwise it falls back to osascript.
 */
export function createDesktopNotifier(options: NotifierOptions = {}): DesktopNotifier {
  const platform = options.platform ?? process.platform;
  const findNotifier = options.findNotifier ?? findTerminalNotifier;
  const spawn = options.spawn ?? defaultSpawn;
  return ({ title, message, url }) => {
    // One line per branch feeds the daemon.log audit trail (which backend ran,
    // and whether the banner is clickable). Plain writes — never throws.
    if (platform !== "darwin") {
      process.stderr.write(`otacond: notify backend=none-non-darwin clickable=false title=${JSON.stringify(title)}\n`);
      return; // banners are macOS-only here
    }
    const terminalNotifier = findNotifier();
    if (terminalNotifier !== undefined) {
      const args = ["-title", title, "-message", message];
      if (url !== undefined) args.push("-open", url);
      process.stderr.write(
        `otacond: notify backend=terminal-notifier clickable=${url !== undefined} title=${JSON.stringify(title)}\n`,
      );
      spawn(terminalNotifier, args);
      return;
    }
    process.stderr.write(`otacond: notify backend=osascript clickable=false title=${JSON.stringify(title)}\n`);
    spawn("osascript", [
      "-e",
      `display notification ${osaQuote(message)} with title ${osaQuote(title)}`,
    ]);
  };
}
