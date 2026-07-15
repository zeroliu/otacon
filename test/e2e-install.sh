#!/usr/bin/env bash
# End-to-end exercise of the M5 install/ops surface against the real built
# artifact: install writes the wrappers
# (idempotently; --hooks merges settings.json additively), doctor reports green
# on a healthy setup and red on a squatted port, open prints the right URLs,
# a full mini-loop then approve then clean archives the session dir and prunes
# the registry while the .otacon/plans project copy + home archive survive, the
# Stop hook blocks/allows
# correctly, and expose handles both a missing tailscale (graceful error) and
# a stubbed one (tailnet URL). Hermetic: temp HOME, temp OTACON_HOME, temp git
# repos, ephemeral port, OTACON_TAILSCALE pinned away from any real tailscale.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
export HOME="$TMP/home"
export OTACON_HOME="$TMP/otacon-home"
export OTACON_TAILSCALE="/nonexistent-tailscale" # never touch a real tailnet
export OTACON_NO_BROWSER=1 # open/config print the URL here instead of spawning a browser
REPO="$TMP/repo"
REPO2="$TMP/repo2"
REPO3="$TMP/repo3"
INSTALL_REPO="$TMP/install-repo"
MIGRATION_REPO="$TMP/migration-repo"
mkdir -p "$HOME" "$OTACON_HOME" "$REPO" "$REPO2" "$REPO3" "$INSTALL_REPO" "$MIGRATION_REPO"

BASE=""
SQUAT_PID=""
PASS=0
cleanup() {
  [ -n "$BASE" ] && curl -s -X POST "$BASE/api/shutdown" > /dev/null 2>&1 || true
  [ -n "$SQUAT_PID" ] && kill -9 "$SQUAT_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); echo "ok $PASS - $1"; }
json_field() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).$1" < "$2"; }
free_port() {
  node -e 's=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}
assert_protocol_pair() {
  local plan="$1" review="$2" label="$3"
  [ -f "$plan" ] || fail "$label plan skill missing at $plan"
  [ -f "$review" ] || fail "$label review skill missing at $review"
  head -2 "$plan" | grep -q '^name: otacon$' || fail "$label plan skill has the wrong identity"
  head -2 "$review" | grep -q '^name: otacon-review$' || fail "$label review skill has the wrong identity"
  grep -q 'otacon start --title' "$plan" || fail "$label plan skill lost the plan protocol"
  grep -q 'otacon review start --pr' "$review" || fail "$label review skill lost the review protocol"
  if grep -q 'otacon review start --pr' "$plan"; then fail "$label plan skill absorbed review behavior"; fi
  if grep -q 'start --title <kebab-title>' "$review"; then fail "$label review skill absorbed plan behavior"; fi
}

echo "# building"
(cd "$ROOT" && bun run build > /dev/null)

PORT="$(free_port)"
export OTACON_PORT="$PORT"
BASE="http://127.0.0.1:$PORT"
otacon() { node "$ROOT/dist/cli/main.js" "$@"; }

SKILL="$HOME/.claude/skills/otacon/SKILL.md"
SKILL_DIR="$(dirname "$SKILL")"
REVIEW_SKILL="$HOME/.claude/skills/otacon-review/SKILL.md"
REVIEW_SKILL_DIR="$(dirname "$REVIEW_SKILL")"
HOOK="$HOME/.claude/hooks/otacon-stop.sh"
SETTINGS="$HOME/.claude/settings.json"

# --- 1. install --agent claude writes the wrapper + hook script ---------------
otacon install --agent claude > "$TMP/install1.json" 2> /dev/null
[ "$(json_field ok "$TMP/install1.json")" = "true" ] || fail "install did not report ok"
[ -f "$SKILL" ] || fail "SKILL.md missing at $SKILL"
[ -L "$SKILL_DIR" ] || fail "claude skill directory is not a symlink"
[ ! -L "$SKILL" ] || fail "claude SKILL.md itself must not be a symlink"
[ -L "$REVIEW_SKILL_DIR" ] || fail "claude review skill directory is not a symlink"
[ ! -L "$REVIEW_SKILL" ] || fail "claude review SKILL.md itself must not be a symlink"
grep -q 'managed by `otacon install`' "$SKILL" || fail "SKILL.md missing the managed marker"
grep -q 'managed by `otacon install`' "$REVIEW_SKILL" || fail "review SKILL.md missing the managed marker"
for needle in 'otacon start --title' 'otacon ask --question' 'otacon wait --timeout 540' \
  'otacon submit --resolutions resolutions.json' 'otacon answer' 'otacon status' \
  'Never end your turn' 'caffeinate -i' '600000 ms'; do
  grep -q "$needle" "$SKILL" || fail "SKILL.md missing protocol text: $needle"
done
assert_protocol_pair "$SKILL" "$REVIEW_SKILL" "claude user install"
[ -x "$HOOK" ] || fail "Stop hook script missing or not executable at $HOOK"
grep -q '"decision":"block"' "$HOOK" || fail "hook script lacks the block decision JSON"
node -e '
const out = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const claude = out.installed.find((entry) => entry.agent === "claude");
if (out.scope !== "user") process.exit(1);
if (claude.skills.map((skill) => skill.name).join(",") !== "otacon,otacon-review") process.exit(2);
' "$TMP/install1.json" || fail "claude install did not report both user-scope skills"
ok "install --agent claude linked both user skills and wrote the hook script"

# --- 2. reinstall is idempotent ------------------------------------------------
cp "$SKILL" "$TMP/skill.before"; cp "$REVIEW_SKILL" "$TMP/review-skill.before"; cp "$HOOK" "$TMP/hook.before"
otacon install --agent claude > /dev/null 2>&1
cmp -s "$SKILL" "$TMP/skill.before" || fail "reinstall changed SKILL.md"
cmp -s "$REVIEW_SKILL" "$TMP/review-skill.before" || fail "reinstall changed review SKILL.md"
cmp -s "$HOOK" "$TMP/hook.before" || fail "reinstall changed the hook script"
ok "reinstall keeps both skill protocols byte-identical (managed-file overwrite is a fixpoint)"

# --- 3. --hooks merges settings.json additively and idempotently ---------------
mkdir -p "$HOME/.claude"
cat > "$SETTINGS" <<'JSON'
{"model":"opus","permissions":{"allow":["Bash(ls:*)"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo pre"}]}]}}
JSON
otacon install --agent claude --hooks > "$TMP/hooks.json" 2> /dev/null
[ "$(json_field hooks.registered "$TMP/hooks.json")" = "true" ] || fail "--hooks did not register"
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const hook = process.argv[2];
if (s.model !== "opus") process.exit(1);
if (s.permissions.allow[0] !== "Bash(ls:*)") process.exit(2);
if (s.hooks.PreToolUse.length !== 1 || s.hooks.PreToolUse[0].hooks[0].command !== "echo pre") process.exit(3);
const stop = s.hooks.Stop;
if (!Array.isArray(stop) || stop.length !== 1) process.exit(4);
if (stop[0].hooks[0].command !== hook) process.exit(5);
' "$SETTINGS" "$HOOK" || fail "settings.json merge clobbered pre-existing keys or miswired the Stop hook"
BACKUPS=$(ls "$HOME/.claude/"settings.json.otacon-backup-* 2>/dev/null | wc -l | tr -d ' ')
[ "$BACKUPS" = "1" ] || fail "expected exactly 1 settings backup, found $BACKUPS"
otacon install --agent claude --hooks > /dev/null 2>&1
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (s.hooks.Stop.length !== 1) process.exit(1);
' "$SETTINGS" || fail "second --hooks run duplicated the Stop entry"
BACKUPS=$(ls "$HOME/.claude/"settings.json.otacon-backup-* 2>/dev/null | wc -l | tr -d ' ')
[ "$BACKUPS" = "1" ] || fail "idempotent --hooks rerun should not write another backup"
ok "--hooks merged additively (keys survive, backup once) and reruns are no-ops"

# --- 4. codex: SKILL.md in its own skills dir ----------------------------------
CODEX_SKILL="$HOME/.codex/skills/otacon/SKILL.md"
CODEX_SKILL_DIR="$(dirname "$CODEX_SKILL")"
CODEX_REVIEW_SKILL="$HOME/.codex/skills/otacon-review/SKILL.md"
CODEX_REVIEW_SKILL_DIR="$(dirname "$CODEX_REVIEW_SKILL")"
otacon install --agent codex > /dev/null 2>&1
[ -f "$CODEX_SKILL" ] || fail "codex SKILL.md missing at $CODEX_SKILL"
[ -L "$CODEX_SKILL_DIR" ] || fail "codex skill directory is not a symlink"
[ ! -L "$CODEX_SKILL" ] || fail "codex SKILL.md itself must not be a symlink"
[ -L "$CODEX_REVIEW_SKILL_DIR" ] || fail "codex review skill directory is not a symlink"
[ ! -L "$CODEX_REVIEW_SKILL" ] || fail "codex review SKILL.md itself must not be a symlink"
grep -q 'managed by `otacon install`' "$CODEX_SKILL" || fail "codex SKILL.md missing the managed marker"
grep -q 'otacon wait --timeout 540' "$CODEX_SKILL" || fail "codex SKILL.md missing the protocol"
assert_protocol_pair "$CODEX_SKILL" "$CODEX_REVIEW_SKILL" "codex user install"
cp "$CODEX_SKILL" "$TMP/codex.before"; cp "$CODEX_REVIEW_SKILL" "$TMP/codex-review.before"
otacon install --agent codex > /dev/null 2>&1
cmp -s "$CODEX_SKILL" "$TMP/codex.before" || fail "codex reinstall changed SKILL.md"
cmp -s "$CODEX_REVIEW_SKILL" "$TMP/codex-review.before" || fail "codex reinstall changed review SKILL.md"
ok "codex install linked both complete skill directories (reinstall is a fixpoint)"

# --- 5. --all covers opencode too ----------------------------------------------
otacon install --all > /dev/null 2>&1
OC_SKILL="$HOME/.config/opencode/skills/otacon/SKILL.md"
OC_SKILL_DIR="$(dirname "$OC_SKILL")"
OC_REVIEW_SKILL="$HOME/.config/opencode/skills/otacon-review/SKILL.md"
OC_REVIEW_SKILL_DIR="$(dirname "$OC_REVIEW_SKILL")"
[ -f "$OC_SKILL" ] || fail "opencode SKILL.md missing at $OC_SKILL"
[ -L "$OC_SKILL_DIR" ] || fail "opencode skill directory is not a symlink"
[ ! -L "$OC_SKILL" ] || fail "opencode SKILL.md itself must not be a symlink"
[ -L "$OC_REVIEW_SKILL_DIR" ] || fail "opencode review skill directory is not a symlink"
[ ! -L "$OC_REVIEW_SKILL" ] || fail "opencode review SKILL.md itself must not be a symlink"
grep -q 'otacon wait --timeout 540' "$OC_SKILL" || fail "opencode SKILL.md missing the protocol"
assert_protocol_pair "$OC_SKILL" "$OC_REVIEW_SKILL" "opencode user install"
ok "install --all linked both opencode skill directories"

# --- 6. project scope copies both independent skills for every agent -----------
cd "$INSTALL_REPO"
git init -q -b main .
otacon install --all --project > "$TMP/install-project.json" 2> /dev/null
[ "$(json_field scope "$TMP/install-project.json")" = "project" ] || fail "project install reported the wrong scope"
for agent in .claude .codex .opencode; do
  project_plan="$INSTALL_REPO/$agent/skills/otacon/SKILL.md"
  project_review="$INSTALL_REPO/$agent/skills/otacon-review/SKILL.md"
  assert_protocol_pair "$project_plan" "$project_review" "$agent project install"
  [ ! -L "$(dirname "$project_plan")" ] || fail "$agent project plan skill must be a portable copy"
  [ ! -L "$(dirname "$project_review")" ] || fail "$agent project review skill must be a portable copy"
done
node -e '
const out = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (out.installed.length !== 3) process.exit(1);
for (const entry of out.installed) {
  if (entry.skills.length !== 2 || entry.skills.some((skill) => skill.mode !== "copy")) process.exit(2);
}
' "$TMP/install-project.json" || fail "project install did not report two copied skills for every agent"
ok "install --all --project copied both isolated skills for every agent"

# --- 7. a legacy plan-only install gains review without changing plan bytes ----
cd "$MIGRATION_REPO"
git init -q -b main .
LEGACY_PLAN="$MIGRATION_REPO/.codex/skills/otacon/SKILL.md"
MIGRATED_REVIEW="$MIGRATION_REPO/.codex/skills/otacon-review/SKILL.md"
mkdir -p "$(dirname "$LEGACY_PLAN")"
cp "$ROOT/dist/skills/otacon/SKILL.md" "$LEGACY_PLAN"
cp "$LEGACY_PLAN" "$TMP/legacy-plan.before"
[ ! -e "$MIGRATED_REVIEW" ] || fail "legacy fixture unexpectedly already has the review skill"
otacon install --agent codex --project > /dev/null 2>&1
cmp -s "$LEGACY_PLAN" "$TMP/legacy-plan.before" || fail "plan-only migration changed existing plan protocol bytes"
assert_protocol_pair "$LEGACY_PLAN" "$MIGRATED_REVIEW" "legacy plan-only migration"
ok "legacy plan-only install gained the review skill without changing plan bytes or behavior"

# --- 8. open: index URL with no session, session URL afterwards ----------------
cd "$REPO"
git init -q -b main .
otacon open > "$TMP/open0.json" 2> /dev/null
[ "$(json_field url "$TMP/open0.json")" = "$BASE/" ] || fail "open without a session should print the index URL"
otacon start --title "install loop" > "$TMP/start.json" 2> /dev/null
SID="$(json_field session "$TMP/start.json")"
PLAN="$(json_field plan "$TMP/start.json")"
otacon open > "$TMP/open1.json" 2> /dev/null
[ "$(json_field url "$TMP/open1.json")" = "$BASE/s/$SID" ] || fail "open did not print the session URL"
otacon open --session "$SID" > "$TMP/open2.json" 2> /dev/null
[ "$(json_field session "$TMP/open2.json")" = "$SID" ] || fail "open --session override failed"
ok "open prints the index URL (no session) and the review URL (session + --session)"

# --- 9. mini-loop → approve → clean archives and prunes -------------------------
mkdir -p "$(dirname "$PLAN")"
sed "s/otc_test01/$SID/" "$ROOT/test/fixtures/valid-plan.md" > "$PLAN"
otacon submit > /dev/null
curl -s -X POST "$BASE/api/sessions/$SID/approve" -H 'content-type: application/json' \
  -d '{"force":true}' > "$TMP/approved.json"
# A plain Save: path = the project copy under .otacon/plans; home = the archive.
ART_PATH="$(json_field path "$TMP/approved.json")"
[[ "$ART_PATH" == .otacon/plans/*.md ]] || fail "unexpected artifact path $ART_PATH"
HOME_ART="$(json_field home "$TMP/approved.json")"
[[ "$HOME_ART" == "$OTACON_HOME/sessions/$SID/"*.md ]] || fail "unexpected home archive path $HOME_ART"
[ -f "$HOME_ART" ] || fail "approval did not write the canonical home artifact"
otacon wait --timeout 10 --session "$SID" > "$TMP/wait.json"
[ "$(json_field event "$TMP/wait.json")" = "approved" ] || fail "wait did not drain the approved event"
otacon clean > "$TMP/clean.json" 2> /dev/null
[ "$(json_field 'cleaned[0].session' "$TMP/clean.json")" = "$SID" ] || fail "clean did not report the session"
# Clean permanently removes the home working folder but must never touch the
# durable project plan copy under plans.dir.
[ ! -d "$OTACON_HOME/sessions/$SID" ] || fail "home session folder still exists after clean"
[ ! -d "$REPO/.otacon/archive" ] || fail "clean must not create a legacy repo archive"
[ -f "$REPO/$ART_PATH" ] || fail "clean must never touch the .otacon/plans project copy"
[ ! -f "$HOME_ART" ] || fail "clean left the canonical home artifact behind"
curl -s "$BASE/api/sessions" | grep -q "$SID" && fail "registry still lists the cleaned session"
otacon clean > "$TMP/clean2.json" 2> /dev/null
[ "$(json_field 'cleaned.length' "$TMP/clean2.json")" = "0" ] || fail "second clean should find nothing"
ok "clean removed the home session, pruned the registry, and kept the durable .otacon/plans copy"

# --- 10. Stop hook: blocks open, allows approved/absent/daemon-down -------------
cd "$REPO2"
git init -q -b main .
otacon start --title "hook block" > "$TMP/start2.json" 2> /dev/null
SID2="$(json_field session "$TMP/start2.json")"
PLAN2="$(json_field plan "$TMP/start2.json")"
printf '{"cwd":"%s"}' "$REPO2" | sh "$HOOK" > "$TMP/hook-open.out"
grep -q '"decision":"block"' "$TMP/hook-open.out" || fail "hook did not block an open session"
grep -q "$SID2" "$TMP/hook-open.out" || fail "hook block reason should name the session"
mkdir -p "$(dirname "$PLAN2")"
sed "s/otc_test01/$SID2/" "$ROOT/test/fixtures/valid-plan.md" > "$PLAN2"
otacon submit > /dev/null
curl -s -X POST "$BASE/api/sessions/$SID2/approve" -H 'content-type: application/json' \
  -d '{"force":true}' > /dev/null
printf '{"cwd":"%s"}' "$REPO2" | sh "$HOOK" > "$TMP/hook-approved.out"
[ ! -s "$TMP/hook-approved.out" ] || fail "hook should allow a stop once the session is approved"
printf '{"cwd":"%s"}' "$REPO3" | sh "$HOOK" > "$TMP/hook-absent.out"
[ ! -s "$TMP/hook-absent.out" ] || fail "hook should allow a stop with no session for the repo"
cd "$REPO3"
git init -q -b main .
otacon start --title "hook daemon down" > /dev/null 2>&1
DEAD_PORT="$(free_port)"
printf '{"cwd":"%s"}' "$REPO3" | OTACON_PORT="$DEAD_PORT" sh "$HOOK" > "$TMP/hook-down.out"
[ ! -s "$TMP/hook-down.out" ] || fail "hook must fail open when the daemon is down"
ok "Stop hook blocks an open session; allows approved, no-session, and daemon-down stops"

# --- 11. doctor: green on a healthy setup ---------------------------------------
otacon doctor > "$TMP/doctor-ok.json" 2> /dev/null || fail "doctor exited nonzero on a healthy setup"
[ "$(json_field ok "$TMP/doctor-ok.json")" = "true" ] || fail "doctor ok should be true"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const get = (n) => r.checks.find((c) => c.name === n);
if (get("node").status !== "ok") process.exit(1);
if (get("daemon").status !== "ok" || !get("daemon").detail.includes("otacond")) process.exit(2);
for (const n of [
  "skill-claude-otacon", "skill-claude-otacon-review",
  "skill-codex-otacon", "skill-codex-otacon-review",
  "skill-opencode-otacon", "skill-opencode-otacon-review",
  "stop-hook",
])
  if (get(n).status !== "ok") process.exit(3);
if (get("tailscale").status !== "warn") process.exit(4); // pinned to a nonexistent binary
if (r.checks.some((c) => c.status === "fail")) process.exit(5);
' "$TMP/doctor-ok.json" || fail "doctor green report has wrong check statuses"
ok "doctor reports green: node, daemon, both skills for every agent, stop hook ok; tailscale a warning"

# --- 12. doctor: red when the port is squatted by a foreign server --------------
curl -s -X POST "$BASE/api/shutdown" > /dev/null
node -e '
require("http").createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ app: "squatter" }));
}).listen(process.env.OTACON_PORT, "127.0.0.1", () => console.log("squatting"));
' > "$TMP/squat.log" &
SQUAT_PID=$!
for _ in $(seq 1 50); do grep -q squatting "$TMP/squat.log" 2>/dev/null && break; sleep 0.1; done
set +e
otacon doctor > "$TMP/doctor-red.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "doctor on a squatted port exited $CODE, expected 1"
[ "$(json_field ok "$TMP/doctor-red.json")" = "false" ] || fail "doctor ok should be false"
grep -q 'E_PORT_CONFLICT' "$TMP/doctor-red.json" || fail "daemon check should fail with E_PORT_CONFLICT"
kill -9 "$SQUAT_PID" 2>/dev/null || true
wait "$SQUAT_PID" 2>/dev/null || true # reap quietly (suppress bash's "Killed" notice)
SQUAT_PID=""
ok "doctor exits 1 with a failed daemon check while the port is squatted"

# --- 13. expose: graceful error without tailscale; tailnet URL with a stub -------
set +e
otacon expose > "$TMP/expose-missing.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "expose without tailscale exited $CODE, expected 1"
[ "$(json_field error.code "$TMP/expose-missing.json")" = "E_TAILSCALE_MISSING" ] || fail "expose missing-tailscale code wrong"
mkdir -p "$TMP/bin"
cat > "$TMP/bin/tailscale" <<'SH'
#!/bin/sh
case "$1" in
  version) echo "1.99.9" ;;
  status) printf '{"BackendState":"Running","Self":{"DNSName":"zeros-mac.tail1234.ts.net."}}\n' ;;
  serve) exit 0 ;;
  *) exit 1 ;;
esac
SH
chmod +x "$TMP/bin/tailscale"
# The stub's tailnet name never resolves, so verification fails fast (DNS) →
# ok:true with verified:false and a pointer at enabling HTTPS certs. The
# OTACON_EXPOSE_VERIFY_* knobs keep this hermetic and instant.
OTACON_TAILSCALE="$TMP/bin/tailscale" OTACON_EXPOSE_VERIFY_ATTEMPTS=1 OTACON_EXPOSE_VERIFY_DELAY_MS=0 \
  otacon expose > "$TMP/expose-ok.json" 2> "$TMP/expose-ok.err"
[ "$(json_field ok "$TMP/expose-ok.json")" = "true" ] || fail "stubbed expose did not report ok"
[ "$(json_field url "$TMP/expose-ok.json")" = "https://zeros-mac.tail1234.ts.net/" ] || fail "expose printed the wrong tailnet URL"
[ "$(json_field target "$TMP/expose-ok.json")" = "http://127.0.0.1:$PORT" ] || fail "expose serves the wrong target"
[ "$(json_field verified "$TMP/expose-ok.json")" = "false" ] || fail "unreachable stub tailnet URL should report verified:false"
grep -q 'admin/dns' "$TMP/expose-ok.err" || fail "unverified expose should point at enabling HTTPS certs"
ok "expose fails gracefully without tailscale; with one it serves, verifies, and flags an unreachable URL"

echo "# e2e-install: all $PASS checks passed"
