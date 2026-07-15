#!/usr/bin/env bash
# bun run smoke — the M1 acceptance loop against the BUILT artifact. It covers
# the core daemon loop, minus grill/approve which land in later UI tests: status
# auto-spawns the daemon, start mints a session in a fresh git repo, a bad plan
# is lint-rejected, the fixed plan stores revision 1, a parked wait is fed by a
# comment POSTed over curl (the phone's path), status reports the queue going
# pending → delivered, and shutdown ends the daemon. Hermetic: temp
# OTACON_HOME, temp git repo, ephemeral port. This is the concise "is the
# product alive" proof — edge cases live in test/e2e-daemon.sh and
# test/e2e-cli.sh.
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
otacon() { node "$ROOT/dist/cli/main.js" "$@"; }

# --- 1. status auto-spawns the daemon ----------------------------------------
cd "$REPO"
git init -q -b main .
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

# --- 6. shutdown ends the daemon ----------------------------------------------
curl -s -X POST "$BASE/api/shutdown" | grep -q '"ok":true' || fail "shutdown did not respond ok"
for _ in $(seq 1 30); do
  kill -0 "$DAEMON_PID" 2>/dev/null || { DAEMON_PID=""; break; }
  sleep 0.1
done
[ -z "$DAEMON_PID" ] || fail "daemon still alive after /api/shutdown"
ok "POST /api/shutdown ended the daemon"

echo "# smoke: all $PASS checks passed — the M1 loop is alive"
