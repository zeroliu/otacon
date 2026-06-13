// Where each agent reads its wrapper from (DESIGN.md §16; DECISIONS.md
// "Wrapper destinations per agent"), plus the merge/registration helpers
// install and doctor share. homedir() honors $HOME, which is what keeps the
// install e2e hermetic under a temp HOME.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export function claudeSkillPath() {
    return join(homedir(), ".claude", "skills", "otacon", "SKILL.md");
}
/** The Stop hook script install writes; settings.json references it by this path. */
export function claudeHookScriptPath() {
    return join(homedir(), ".claude", "hooks", "otacon-stop.sh");
}
export function claudeSettingsPath() {
    return join(homedir(), ".claude", "settings.json");
}
/** Codex's global instructions file ($CODEX_HOME, default ~/.codex). */
export function codexAgentsPath() {
    return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "AGENTS.md");
}
/** OpenCode's global skills dir ($XDG_CONFIG_HOME, default ~/.config). */
export function opencodeSkillPath() {
    return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "skills", "otacon", "SKILL.md");
}
/**
 * Replace the marker-delimited block in `existing` with `block` (which carries
 * its own begin/end lines), or append it when no markers are present. User
 * content outside the markers survives byte-for-byte; re-running with the same
 * block is a fixpoint (the idempotent-reinstall contract).
 */
export function upsertMarkedBlock(existing, block, begin, end) {
    const from = existing.indexOf(begin);
    const to = existing.indexOf(end);
    if (from !== -1 && to !== -1 && to > from) {
        return existing.slice(0, from) + block + existing.slice(to + end.length);
    }
    if (existing.trim() === "")
        return `${block}\n`;
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}${block}\n`;
}
/**
 * Whether ~/.claude/settings.json currently registers the otacon Stop hook
 * (install's offer path and doctor's check). Missing or unparseable settings
 * read as "not registered" — only --hooks treats unparseable as an error.
 */
export function settingsRegisterStopHook() {
    try {
        const raw = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
        return stopHookRegistered(raw?.hooks?.Stop, claudeHookScriptPath());
    }
    catch {
        return false;
    }
}
/** True when some Stop matcher entry already runs `command`. */
export function stopHookRegistered(stop, command) {
    if (!Array.isArray(stop))
        return false;
    return stop.some((entry) => {
        const hooks = entry?.hooks;
        return (Array.isArray(hooks) &&
            hooks.some((h) => h?.command === command));
    });
}
/**
 * Additively merge the Stop hook entry into a parsed settings.json: every
 * existing key (and every existing Stop matcher) is preserved; an entry already
 * running `command` makes this a no-op. Returns undefined when the existing
 * structure has a shape we refuse to rewrite (hooks or hooks.Stop not
 * object/array) — never clobber what we cannot faithfully merge.
 */
export function mergeStopHook(raw, command) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const settings = raw;
    const hooks = settings.hooks ?? {};
    if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks))
        return undefined;
    const stop = hooks.Stop ?? [];
    if (!Array.isArray(stop))
        return undefined;
    if (stopHookRegistered(stop, command))
        return { settings, changed: false };
    const entry = { matcher: "", hooks: [{ type: "command", command }] };
    return {
        settings: { ...settings, hooks: { ...hooks, Stop: [...stop, entry] } },
        changed: true,
    };
}
//# sourceMappingURL=locations.js.map