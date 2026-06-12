#!/usr/bin/env bash
# End-to-end exercise of the otacon CLI (M1g+) against the real built artifact:
# daemon auto-spawn via `otacon status`. Hermetic: temp OTACON_HOME, temp git
# repo, ephemeral port.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
export OTACON_HOME="$TMP/home"
REPO="$TMP/repo"
mkdir -p "$OTACON_HOME" "$REPO"

DAEMON_PID=""
WAIT_PID=""
PASS=0
cleanup() {
  curl -s -X POST "$BASE/api/shutdown" > /dev/null 2>&1 || true
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

# --- 1. status in empty state auto-spawns the daemon ------------------------
cd "$TMP"
otacon status > "$TMP/status1.json" 2> "$TMP/status1.err" \
  || fail "status exited nonzero in empty state ($(cat "$TMP/status1.err"))"
[ "$(json_field ok "$TMP/status1.json")" = "true" ] || fail "status did not report ok"
[ "$(json_field 'sessions.length' "$TMP/status1.json")" = "0" ] || fail "expected no sessions"
DAEMON_PID="$(json_field daemon.pid "$TMP/status1.json")"
kill -0 "$DAEMON_PID" 2>/dev/null || fail "reported daemon pid $DAEMON_PID is not alive"
curl -sf "$BASE/api/health" > "$TMP/health.json"
[ "$(json_field app "$TMP/health.json")" = "otacond" ] || fail "spawned daemon is not otacond"
[ "$(json_field pid "$TMP/health.json")" = "$DAEMON_PID" ] || fail "health pid mismatch"
otacon status > "$TMP/status2.json"
[ "$(json_field daemon.pid "$TMP/status2.json")" = "$DAEMON_PID" ] \
  || fail "second status respawned instead of reusing the daemon"
ok "status auto-spawned otacond (pid $DAEMON_PID), reported empty state, exited 0"

echo "# e2e-cli: all $PASS checks passed"
