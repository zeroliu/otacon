// otacon install --agent claude|codex|opencode [--agent …] | --all [--hooks] —
// write the protocol wrapper into each agent's skill location (DESIGN.md §16).
// Pure file writes — no daemon needed. Wrappers are managed files: reinstall
// overwrites them (Codex: only the marked block inside its shared AGENTS.md).
// --hooks additionally registers the Claude Code Stop hook in
// ~/.claude/settings.json — merged additively and idempotently, with a backup
// before the first change, never clobbering what cannot be parsed.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { CODEX_BEGIN, CODEX_END, codexBlock, skillMd, STOP_HOOK_SCRIPT } from "../install/assets.js";
import { claudeHookScriptPath, claudeSettingsPath, claudeSkillPath, codexAgentsPath, mergeStopHook, opencodeSkillPath, settingsRegisterStopHook, upsertMarkedBlock, } from "../install/locations.js";
import { fail, notice, printJson, usageError } from "../output.js";
const AGENTS = ["claude", "codex", "opencode"];
function writeManaged(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
function installAgent(agent) {
    switch (agent) {
        case "claude": {
            writeManaged(claudeSkillPath(), skillMd());
            writeManaged(claudeHookScriptPath(), STOP_HOOK_SCRIPT);
            chmodSync(claudeHookScriptPath(), 0o755);
            return { agent, files: [claudeSkillPath(), claudeHookScriptPath()] };
        }
        case "codex": {
            const path = codexAgentsPath();
            const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
            writeManaged(path, upsertMarkedBlock(existing, codexBlock(), CODEX_BEGIN, CODEX_END));
            return { agent, files: [path] };
        }
        case "opencode": {
            writeManaged(opencodeSkillPath(), skillMd());
            return { agent, files: [opencodeSkillPath()] };
        }
    }
}
/** Register the Stop hook in ~/.claude/settings.json (additive, idempotent, backed up). */
function applyStopHook() {
    const path = claudeSettingsPath();
    const command = claudeHookScriptPath();
    let raw = {};
    if (existsSync(path)) {
        try {
            raw = JSON.parse(readFileSync(path, "utf8"));
        }
        catch {
            fail("E_SETTINGS_UNREADABLE", `${path} is not valid JSON; fix it by hand — otacon never overwrites settings it cannot parse`);
        }
    }
    const merged = mergeStopHook(raw, command);
    if (!merged) {
        fail("E_SETTINGS_SHAPE", `${path} has a hooks/hooks.Stop shape otacon cannot merge into; add the Stop hook by hand (command: ${command})`);
    }
    if (!merged.changed)
        return { registered: true, command, settings: path };
    let backup;
    if (existsSync(path)) {
        backup = `${path}.otacon-backup-${Date.now()}`;
        copyFileSync(path, backup);
        notice(`backed up ${path} to ${backup}`);
    }
    writeManaged(path, `${JSON.stringify(merged.settings, null, 2)}\n`);
    notice(`registered the otacon Stop hook in ${path}`);
    return { registered: true, command, settings: path, ...(backup ? { backup } : {}) };
}
/** Without --hooks: report the current state and offer the flag (DESIGN.md §16). */
function offerStopHook() {
    const path = claudeSettingsPath();
    const registered = settingsRegisterStopHook();
    if (!registered) {
        notice("Stop hook not registered — run `otacon install --agent claude --hooks` to add it to " +
            `${path} (merged additively, existing settings preserved, backup written first)`);
    }
    return {
        registered,
        command: claudeHookScriptPath(),
        settings: path,
        ...(registered ? {} : { hint: "re-run with --hooks to register the Stop hook" }),
    };
}
export async function installCommand(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            agent: { type: "string", multiple: true },
            all: { type: "boolean", default: false },
            hooks: { type: "boolean", default: false },
        },
    });
    const picked = values.all ? [...AGENTS] : (values.agent ?? []);
    if (picked.length === 0) {
        usageError("otacon install requires --agent claude|codex|opencode (repeatable) or --all");
    }
    const unknown = picked.find((a) => !AGENTS.includes(a));
    if (unknown !== undefined) {
        usageError(`unknown agent "${unknown}" — expected claude, codex, or opencode`);
    }
    const agents = [...new Set(picked)];
    if (values.hooks && !agents.includes("claude")) {
        usageError("--hooks registers the Claude Code Stop hook; include --agent claude (or --all)");
    }
    const installed = agents.map(installAgent);
    const hooks = agents.includes("claude")
        ? values.hooks
            ? applyStopHook()
            : offerStopHook()
        : undefined;
    printJson({ ok: true, installed, ...(hooks ? { hooks } : {}) });
    return 0;
}
//# sourceMappingURL=install.js.map