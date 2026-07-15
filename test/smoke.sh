#!/usr/bin/env bash
# bun run smoke — the M1 acceptance loop against the BUILT artifact. It covers
# the core daemon loop, minus grill/approve which land in later UI tests: status
# auto-spawns the daemon, start mints a session in a fresh git repo, a bad plan
# is lint-rejected, the fixed plan stores revision 1, a parked wait is fed by a
# comment POSTed over curl (the phone's path), status reports the queue going
# pending → delivered, then the shipped CLI starts a representative PR review
# and round-trips user knowledge. Every CLI invocation runs under plain Node
# with Bun absent from PATH and is checked for exactly one JSON stdout line.
# Hermetic: temp OTACON_HOME, temp git repo, stubbed gh, ephemeral port. This is
# the concise "is the product alive" proof — edge cases live in
# test/e2e-daemon.sh and test/e2e-cli.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
export OTACON_HOME="$TMP/home"
REPO="$TMP/repo"
mkdir -p "$OTACON_HOME" "$REPO"
printf '{"notifications":{"desktop":false}}' > "$OTACON_HOME/config.json" # hermetic: no real desktop banners

BASE="" # set once the port is picked; the trap may fire before that (set -u)
DAEMON_PID=""
WAIT_PID=""
PASS=0
cleanup() {
  [ -n "$BASE" ] && curl -s -X POST "$BASE/api/shutdown" > /dev/null 2>&1 || true
  [ -n "$DAEMON_PID" ] && kill -9 "$DAEMON_PID" 2>/dev/null || true
  [ -n "$WAIT_PID" ] && kill -9 "$WAIT_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); echo "ok $PASS - $1"; }
json_field() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).$1" < "$2"; }
free_port() {
  node -e 's=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

echo "# building"
(cd "$ROOT" && bun run build > /dev/null)

PORT="$(free_port)"
export OTACON_PORT="$PORT"
BASE="http://127.0.0.1:$PORT"
NODE="$(command -v node)"
RUNTIME_BIN="$TMP/runtime-bin"
mkdir -p "$RUNTIME_BIN"
cat > "$RUNTIME_BIN/gh" <<'SH'
#!/bin/sh
case "$1:$2" in
  pr:view)
    printf '%s\n' '{"author":{"login":"alice"},"baseRefName":"main","headRefName":"feature/node-smoke","headRefOid":"1111111111111111111111111111111111111111","headRepository":{"nameWithOwner":"acme/smoke","name":"smoke"},"headRepositoryOwner":{"login":"acme"},"isCrossRepository":false,"maintainerCanModify":true,"number":7,"state":"OPEN","title":"Exercise review commands under Node","url":"https://github.com/acme/smoke/pull/7"}'
    ;;
  repo:view)
    printf '%s\n' '{"viewerPermission":"WRITE"}'
    ;;
  *)
    printf 'unexpected gh invocation: %s\n' "$*" >&2
    exit 2
    ;;
esac
SH
chmod +x "$RUNTIME_BIN/gh"
RUNTIME_PATH="$RUNTIME_BIN:/usr/bin:/bin"
if PATH="$RUNTIME_PATH" command -v bun > /dev/null 2>&1; then
  fail "plain-Node runtime PATH unexpectedly contains bun"
fi
otacon() {
  local capture code
  capture="$(mktemp "$TMP/cli-stdout.XXXXXX")"
  if PATH="$RUNTIME_PATH" "$NODE" "$ROOT/dist/cli/main.js" "$@" > "$capture"; then
    code=0
  else
    code=$?
  fi
  "$NODE" -e '
const text = require("fs").readFileSync(process.argv[1], "utf8");
if (text === "" || !text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) process.exit(1);
JSON.parse(text);
' "$capture" || fail "otacon $* did not emit exactly one valid JSON stdout line"
  while IFS= read -r line; do printf '%s\n' "$line"; done < "$capture"
  return "$code"
}

# --- 1. status auto-spawns the daemon ----------------------------------------
cd "$REPO"
git init -q -b main .
git remote add origin https://github.com/acme/smoke.git
otacon status > "$TMP/status0.json" || fail "status exited nonzero in empty state"
[ "$(json_field ok "$TMP/status0.json")" = "true" ] || fail "status did not report ok"
DAEMON_PID="$(json_field daemon.pid "$TMP/status0.json")"
kill -0 "$DAEMON_PID" 2>/dev/null || fail "reported daemon pid $DAEMON_PID is not alive"
ok "status auto-spawned otacond (pid $DAEMON_PID)"

# --- 2. start mints and registers a session ----------------------------------
otacon start --title "smoke plan" > "$TMP/start.json" 2> /dev/null
SID="$(json_field session "$TMP/start.json")"
PLAN="$(json_field plan "$TMP/start.json")"
[[ "$SID" == otc_* ]] || fail "start printed no otc_ session id"
[ -n "$PLAN" ] || fail "start printed no plan path"
ok "start minted session $SID"

# --- 3. failing submit, then passing submit ----------------------------------
mkdir -p "$(dirname "$PLAN")"
printf '# not a plan\n' > "$PLAN"
set +e
otacon submit > "$TMP/lint.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "failing submit exited $CODE, expected 1"
grep -q '"rule":"L1"' "$TMP/lint.json" || fail "lint reject carried no machine-readable issues"

sed "s/otc_test01/$SID/" "$ROOT/test/fixtures/valid-plan.md" > "$PLAN"
otacon submit > "$TMP/submit.json"
[ "$(json_field revision "$TMP/submit.json")" = "1" ] || fail "expected revision 1"
ok "bad plan rejected (exit 1, lint issues); fixed plan stored as revision 1"

# --- 4. parked wait fed by a comment over curl --------------------------------
otacon wait --timeout 30 > "$TMP/wait1.json" &
WAIT_PID=$!
sleep 1
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' \
  -d '{"items":[{"anchor":{"section":"phase-1"},"body":"tighten the goal"}]}' > /dev/null
wait "$WAIT_PID" || fail "parked wait exited nonzero"
WAIT_PID=""
[ "$(json_field event "$TMP/wait1.json")" = "comments" ] || fail "wait did not print the comments event"
[ "$(json_field batch "$TMP/wait1.json")" = "b1" ] || fail "expected batch b1"
ok "parked wait delivered the comment batch posted while it waited"

# --- 5. status reports pending, then delivered --------------------------------
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' \
  -d '{"items":[{"anchor":null,"body":"queued with no waiter"}]}' > /dev/null
otacon status > "$TMP/status-pending.json"
[ "$(json_field 'sessions[0].pendingEvents' "$TMP/status-pending.json")" = "1" ] \
  || fail "status did not report the queued event as pending"
otacon wait --timeout 10 > "$TMP/wait2.json"
[ "$(json_field batch "$TMP/wait2.json")" = "b2" ] || fail "expected batch b2"
otacon status > "$TMP/status-drained.json"
[ "$(json_field 'sessions[0].pendingEvents' "$TMP/status-drained.json")" = "0" ] \
  || fail "status still reports pending events after delivery"
ok "status tracked the queue: 1 pending, then 0 after wait delivered it"

# --- 6. shipped review + knowledge commands run under plain Node -------------
otacon review start --pr 7 > "$TMP/review-start.json" 2> "$TMP/review-start.err"
RID="$(json_field session "$TMP/review-start.json")"
[[ "$RID" == otc_* ]] || fail "review start printed no otc_ session id"
[ "$(json_field action "$TMP/review-start.json")" = "created" ] || fail "review start did not create a session"
[ "$(json_field authoring "$TMP/review-start.json")" = "true" ] || fail "new review was not authoring-ready"
[ "$(json_field pr.identity.repository "$TMP/review-start.json")" = "acme/smoke" ] || fail "review resolved the wrong repository"

otacon knowledge get --scope user > "$TMP/knowledge-get.json" 2> "$TMP/knowledge-get.err"
KHASH="$(json_field document.hash "$TMP/knowledge-get.json")"
[[ "$KHASH" =~ ^[0-9a-f]{64}$ ]] || fail "knowledge get printed no canonical base hash"
printf '%s\n' \
  '# User knowledge' \
  '' \
  '## Preferences' \
  '' \
  '- Prefer runtime smoke coverage.' \
  '' \
  '## Demonstrated concepts' \
  '' \
  '- Understands the shipped Node CLI boundary.' \
  '' \
  '## Needs reinforcement' \
  '' \
  '- None yet.' \
  '' \
  '## Code exposure' \
  '' \
  '- Reviewed the install and smoke commands.' > "$TMP/user-knowledge.md"
otacon knowledge put --scope user --file "$TMP/user-knowledge.md" --base-hash "$KHASH" \
  > "$TMP/knowledge-put.json" 2> "$TMP/knowledge-put.err"
[ "$(json_field document.scope "$TMP/knowledge-put.json")" = "user" ] || fail "knowledge put returned the wrong scope"
grep -q 'shipped Node CLI boundary' "$OTACON_HOME/knowledge/user.md" || fail "knowledge put did not persist the Markdown"
ok "shipped dist review + knowledge commands ran under plain Node with one JSON line each"

# --- 7. shutdown ends the daemon ----------------------------------------------
curl -s -X POST "$BASE/api/shutdown" | grep -q '"ok":true' || fail "shutdown did not respond ok"
for _ in $(seq 1 30); do
  kill -0 "$DAEMON_PID" 2>/dev/null || { DAEMON_PID=""; break; }
  sleep 0.1
done
[ -z "$DAEMON_PID" ] || fail "daemon still alive after /api/shutdown"
ok "POST /api/shutdown ended the daemon"

echo "# smoke: all $PASS checks passed — the M1 loop is alive"
