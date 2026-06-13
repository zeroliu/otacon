#!/usr/bin/env bash
# End-to-end exercise of the real otacond daemon over curl: long-poll
# delivery, queue persistence, kill -9 at-least-once survival, lint reject and
# accept, SPA shell + SSE stream, port-squatter refusal, cross-origin refusal,
# clean shutdown. Hermetic: temp OTACON_HOME, temp repo, ephemeral ports.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
HOME_DIR="$TMP/home"
REPO="$TMP/repo"
mkdir -p "$HOME_DIR" "$REPO"
printf '{"notifications":{"desktop":false}}' > "$HOME_DIR/config.json" # hermetic: no real desktop banners

DAEMON_PID=""
SQUAT_PID=""
PARKED_PID=""
PASS=0
cleanup() {
  [ -n "$DAEMON_PID" ] && kill -9 "$DAEMON_PID" 2>/dev/null || true
  [ -n "$SQUAT_PID" ] && kill -9 "$SQUAT_PID" 2>/dev/null || true
  [ -n "$PARKED_PID" ] && kill -9 "$PARKED_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); echo "ok $PASS - $1"; }
json_field() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).$1" < "$2"; }
free_port() {
  node -e 's=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

start_daemon() {
  OTACON_HOME="$HOME_DIR" OTACON_PORT="$PORT" node "$ROOT/dist/daemon/main.js" >> "$TMP/daemon.log" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 50); do
    if curl -sf --max-time 1 "$BASE/api/health" > "$TMP/health.json" 2>/dev/null; then return 0; fi
    sleep 0.1
  done
  cat "$TMP/daemon.log" >&2
  fail "daemon did not become healthy on $BASE"
}

echo "# building"
(cd "$ROOT" && bun run build > /dev/null)

PORT="$(free_port)"
BASE="http://127.0.0.1:$PORT"
start_daemon
[ "$(json_field app "$TMP/health.json")" = "otacond" ] || fail "health did not identify otacond"
ok "daemon boots and serves /api/health (version $(json_field version "$TMP/health.json"))"

# --- session mint ---------------------------------------------------------
curl -s -X POST "$BASE/api/sessions" -H 'content-type: application/json' \
  -d "{\"title\":\"e2e\",\"repo\":\"$REPO\"}" > "$TMP/session.json"
SID="$(json_field id "$TMP/session.json")"
[[ "$SID" == otc_* ]] || fail "session mint returned no otc_ id"
ok "POST /api/sessions minted $SID"

# --- parked long-poll woken by a comment -----------------------------------
curl -s "$BASE/api/sessions/$SID/events?wait=10" > "$TMP/parked.json" &
PARKED_PID=$!
sleep 0.5
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' \
  -d '{"items":[{"anchor":{"section":"phase-1"},"body":"tighten the goal"}]}' > /dev/null
wait "$PARKED_PID"
PARKED_PID=""
[ "$(json_field event "$TMP/parked.json")" = "comments" ] || fail "parked poll did not get the comments event"
[ "$(json_field batch "$TMP/parked.json")" = "b1" ] || fail "expected batch b1"
[ "$(json_field session "$TMP/parked.json")" = "$SID" ] || fail "event payload missing session field"
ok "parked GET /events returned the comment posted while it waited"

# --- queue persistence: comment with no waiter, fetched later --------------
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' \
  -d '{"items":[{"anchor":null,"body":"no waiter parked for this one"}]}' > /dev/null
curl -s "$BASE/api/sessions/$SID/events" > "$TMP/queued.json"
[ "$(json_field batch "$TMP/queued.json")" = "b2" ] || fail "queued comment was not delivered to a later events call"
ok "comment queued with no waiter is delivered to the next events call"

# --- aborted waiter must not eat events -------------------------------------
curl -s --max-time 1 "$BASE/api/sessions/$SID/events?wait=10" > /dev/null 2>&1 || true
sleep 0.3
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' \
  -d '{"items":[{"anchor":null,"body":"posted after a client abort"}]}' > /dev/null
curl -s "$BASE/api/sessions/$SID/events" > "$TMP/after-abort.json"
[ "$(json_field batch "$TMP/after-abort.json")" = "b3" ] || fail "event was lost to an aborted waiter"
ok "client-aborted poll left the queue intact"

# --- kill -9 before delivery: at-least-once across restart ------------------
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' \
  -d '{"items":[{"anchor":null,"body":"queued, then the daemon dies"}]}' > /dev/null
kill -9 "$DAEMON_PID"
wait "$DAEMON_PID" 2>/dev/null || true
DAEMON_PID=""
start_daemon
curl -s "$BASE/api/sessions/$SID/events" > "$TMP/survived.json"
[ "$(json_field batch "$TMP/survived.json")" = "b4" ] || fail "undelivered event did not survive kill -9"
ok "undelivered event survived kill -9 and restart"

# --- submit: lint reject then accept ----------------------------------------
HTTP=$(printf '# not a plan\n' | curl -s -o "$TMP/lint-fail.json" -w '%{http_code}' \
  -X POST "$BASE/api/sessions/$SID/submit" --data-binary @-)
[ "$HTTP" = "422" ] || fail "invalid plan was not rejected (got $HTTP)"
grep -q '"rule":"L1"' "$TMP/lint-fail.json" || fail "lint reject carried no machine-readable issues"
ok "invalid plan rejected 422 with lint issues"

sed "s/otc_test01/$SID/" "$ROOT/test/fixtures/valid-plan.md" > "$TMP/plan.md"
# The queue checks above left four open comment threads, so this submit must
# carry resolutions (lint L5, M3) — the JSON body is the CLI's wire shape.
node -e '
const fs = require("fs");
const plan = fs.readFileSync(process.argv[1], "utf8");
const threads = Object.fromEntries(["t1", "t2", "t3", "t4"].map((t) => [t, "noted"]));
fs.writeFileSync(process.argv[2], JSON.stringify({ plan, resolutions: { threads } }));
' "$TMP/plan.md" "$TMP/submit-body.json"
HTTP=$(curl -s -o "$TMP/submit.json" -w '%{http_code}' \
  -X POST "$BASE/api/sessions/$SID/submit" -H 'content-type: application/json' \
  --data-binary "@$TMP/submit-body.json")
[ "$HTTP" = "200" ] || { cat "$TMP/submit.json" >&2; fail "valid plan did not pass (got $HTTP)"; }
[ "$(json_field revision "$TMP/submit.json")" = "1" ] || fail "expected revision 1"
[ -f "$REPO/.otacon/$SID/r1.md" ] || fail "r1.md not stored on disk"
curl -s "$BASE/api/sessions/$SID/revisions/1" | cmp -s - "$TMP/plan.md" || fail "revision read-back differs"
ok "valid plan stored as revision 1 and reads back byte-identical"

curl -s "$BASE/api/sessions/$SID" > "$TMP/detail.json"
[ "$(json_field status "$TMP/detail.json")" = "in_review" ] || fail "submit did not set in_review"
ok "session detail reports in_review after submit"

# --- SPA shell and index SSE stream ------------------------------------------
curl -sf "$BASE/s/$SID" | grep -q '<div id="root">' || fail "/s/:id did not serve the SPA shell"
curl -sf "$BASE/" | grep -q '<div id="root">' || fail "/ did not serve the SPA shell"
ok "GET / and GET /s/:id serve the SPA shell"

STREAM="$(curl -s --max-time 2 "$BASE/api/stream" || true)"
printf '%s' "$STREAM" | grep -q "event: snapshot" || fail "/api/stream sent no snapshot frame"
printf '%s' "$STREAM" | grep -q "$SID" || fail "/api/stream snapshot missing the session"
ok "GET /api/stream opens with a snapshot carrying the session"

# --- port squatted by a non-otacon process: refuse to start ------------------
SQUAT_PORT="$(free_port)"
node -e "require('http').createServer((q,r)=>r.end('nope')).listen($SQUAT_PORT,'127.0.0.1')" &
SQUAT_PID=$!
sleep 0.5
if OTACON_HOME="$HOME_DIR" OTACON_PORT="$SQUAT_PORT" node "$ROOT/dist/daemon/main.js" > /dev/null 2> "$TMP/squat.log"; then
  fail "daemon started on a port owned by a non-otacon process"
fi
grep -q "not otacond" "$TMP/squat.log" || fail "missing refusal message"
ok "refuses a port squatted by a non-otacon process"

# --- losing the bind to another otacond is success ---------------------------
OTACON_HOME="$HOME_DIR" OTACON_PORT="$PORT" node "$ROOT/dist/daemon/main.js" > "$TMP/loser.json" 2>&1 \
  || fail "second otacond on the same port should exit 0"
grep -q "already running" "$TMP/loser.json" || fail "missing already-running note"
ok "second otacond on the same port defers and exits 0"

# --- cross-origin state changes are refused ----------------------------------
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/shutdown" \
  -H 'Origin: http://evil.example')
[ "$HTTP" = "403" ] || fail "cross-origin shutdown was not refused (got $HTTP)"
curl -sf --max-time 1 "$BASE/api/health" > /dev/null || fail "daemon died on a refused cross-origin shutdown"
ok "cross-origin POST /api/shutdown is refused 403 and the daemon stays up"

# --- clean shutdown -----------------------------------------------------------
curl -s -X POST "$BASE/api/shutdown" | grep -q '"ok":true' || fail "shutdown did not respond ok"
for _ in $(seq 1 30); do
  kill -0 "$DAEMON_PID" 2>/dev/null || { DAEMON_PID=""; break; }
  sleep 0.1
done
[ -z "$DAEMON_PID" ] || fail "daemon still alive after /api/shutdown"
ok "POST /api/shutdown exits the daemon"

# --- corrupt session.json while stopped: quarantined on restart, never wedged --
printf '{nope' > "$REPO/.otacon/$SID/session.json"
start_daemon
curl -sf "$BASE/api/sessions/$SID" > "$TMP/recovered.json" \
  || fail "corrupt session.json wedged the restarted daemon"
[ "$(json_field revision "$TMP/recovered.json")" = "1" ] \
  || fail "revision was not recovered from the r1.md snapshot"
ls "$REPO/.otacon/$SID/"session.json.corrupt-* > /dev/null 2>&1 \
  || fail "corrupt session.json was not quarantined aside"
ok "corrupt session.json quarantined on restart; revision recovered from snapshots"
curl -s -X POST "$BASE/api/shutdown" > /dev/null

echo "# e2e-daemon: all $PASS checks passed"
