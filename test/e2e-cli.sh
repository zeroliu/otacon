#!/usr/bin/env bash
# End-to-end exercise of the otacon CLI (M1g/M1h) against the real built
# artifact: daemon auto-spawn, start, lint-reject + accepted submit, parked
# wait fed over curl, kill -9 mid-wait with transparent re-park, and the
# never-guess ambiguity refusal. Hermetic: temp OTACON_HOME, temp git repo,
# ephemeral port.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
export OTACON_HOME="$TMP/home"
REPO="$TMP/repo"
mkdir -p "$OTACON_HOME" "$REPO"

BASE="" # set once the port is picked; the trap may fire before that (set -u)
DAEMON_PID=""
WAIT_PID=""
STALE_PID=""
PASS=0
cleanup() {
  [ -n "$BASE" ] && curl -s -X POST "$BASE/api/shutdown" > /dev/null 2>&1 || true
  [ -n "$DAEMON_PID" ] && kill -9 "$DAEMON_PID" 2>/dev/null || true
  [ -n "$WAIT_PID" ] && kill -9 "$WAIT_PID" 2>/dev/null || true
  [ -n "$STALE_PID" ] && kill -9 "$STALE_PID" 2>/dev/null || true
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

# --- 2. start in a git repo: .gitignore append, registry ---------------------
cd "$REPO"
git init -q -b main .
printf 'node_modules/\n' > .gitignore
otacon start --title "e2e plan" > "$TMP/start.json" 2> "$TMP/start.err"
SID="$(json_field session "$TMP/start.json")"
[[ "$SID" == otc_* ]] || fail "start printed no otc_ session id"
grep -qx '\.otacon/' .gitignore || fail ".otacon/ was not appended to .gitignore"
grep -qx 'node_modules/' .gitignore || fail "existing .gitignore content was clobbered"
grep -q 'appended .otacon/' "$TMP/start.err" || fail "no .gitignore notice on stderr"
grep -q "$SID" "$OTACON_HOME/registry.json" || fail "session missing from the registry"
json_field url "$TMP/start.json" | grep -q "/s/$SID" || fail "start printed no review URL"
otacon status > "$TMP/status3.json"
[ "$(json_field 'sessions[0].id' "$TMP/status3.json")" = "$SID" ] || fail "status does not list the session"
ok "start minted $SID, appended .gitignore, registered it"

# --- 3. failing submit, then passing submit ----------------------------------
mkdir -p ".otacon/$SID"
printf '# not a plan\n' > ".otacon/$SID/plan.md"
set +e
otacon submit > "$TMP/lint.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "failing submit exited $CODE, expected 1"
[ "$(json_field ok "$TMP/lint.json")" = "false" ] || fail "lint reject did not say ok:false"
grep -q '"rule":"L1"' "$TMP/lint.json" || fail "lint reject carried no machine-readable issues"

sed "s/otc_test01/$SID/" "$ROOT/test/fixtures/valid-plan.md" > ".otacon/$SID/plan.md"
otacon submit > "$TMP/submit.json"
[ "$(json_field ok "$TMP/submit.json")" = "true" ] || fail "valid submit did not say ok:true"
[ "$(json_field revision "$TMP/submit.json")" = "1" ] || fail "expected revision 1"
[ "$(json_field status "$TMP/submit.json")" = "in_review" ] || fail "expected in_review"
ok "bad plan rejected with lint JSON (exit 1); fixed plan stored as revision 1"

# --- 4. parked wait woken by a comment over curl ------------------------------
otacon wait --timeout 30 > "$TMP/wait1.json" &
WAIT_PID=$!
sleep 1
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' \
  -d '{"items":[{"anchor":{"section":"phase-1"},"body":"tighten the goal"}]}' > /dev/null
wait "$WAIT_PID" || fail "parked wait exited nonzero"
WAIT_PID=""
[ "$(json_field event "$TMP/wait1.json")" = "comments" ] || fail "wait did not print the comments event"
[ "$(json_field session "$TMP/wait1.json")" = "$SID" ] || fail "event payload missing session"
[ "$(json_field batch "$TMP/wait1.json")" = "b1" ] || fail "expected batch b1"
ok "parked wait printed the comment batch posted while it waited (exit 0)"

# --- 4b. user question delivered by wait, answered via otacon answer ----------
curl -s -X POST "$BASE/api/sessions/$SID/questions" -H 'content-type: application/json' \
  -d '{"anchor":{"section":"decisions"},"body":"why RS256?"}' > /dev/null
otacon wait --timeout 10 > "$TMP/question.json"
[ "$(json_field event "$TMP/question.json")" = "question" ] || fail "wait did not deliver the question"
QID="$(json_field id "$TMP/question.json")"
otacon answer "$QID" --body "verifiers only need the public key" > "$TMP/answer.json"
[ "$(json_field ok "$TMP/answer.json")" = "true" ] || fail "answer did not report ok"
[ "$(json_field question "$TMP/answer.json")" = "$QID" ] || fail "answer echoed the wrong question id"
curl -s "$BASE/api/sessions/$SID/threads" > "$TMP/threads.json"
node -e '
const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const q = data.threads.find((t) => t.id === process.argv[2]);
if (!q || !q.answer || q.answer.body !== "verifiers only need the public key") process.exit(1);
' "$TMP/threads.json" "$QID" || fail "GET /threads does not carry the stored answer"
set +e
otacon answer q999 --body nope > "$TMP/badanswer.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "answering an unknown question exited $CODE, expected 1"
[ "$(json_field error.code "$TMP/badanswer.json")" = "E_UNKNOWN_QUESTION" ] || fail "expected E_UNKNOWN_QUESTION"
ok "question delivered by wait; otacon answer stored it on the thread (unknown id refused)"

# --- 5. kill -9 mid-wait: re-park, respawn, still deliver ---------------------
otacon wait --timeout 60 > "$TMP/wait2.json" 2> /dev/null &
WAIT_PID=$!
sleep 1
kill -9 "$DAEMON_PID"
# The parked CLI must notice the dead socket, respawn the daemon, and re-park.
NEW_PID=""
for _ in $(seq 1 100); do
  if curl -sf --max-time 1 "$BASE/api/health" > "$TMP/health2.json" 2>/dev/null; then
    NEW_PID="$(json_field pid "$TMP/health2.json")"
    break
  fi
  sleep 0.1
done
[ -n "$NEW_PID" ] || fail "wait did not respawn the daemon after kill -9"
[ "$NEW_PID" != "$DAEMON_PID" ] || fail "daemon pid unchanged after kill -9?"
DAEMON_PID="$NEW_PID"
sleep 0.5 # let the waiter re-park on the fresh daemon
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' \
  -d '{"items":[{"anchor":null,"body":"posted after the restart"}]}' > /dev/null
wait "$WAIT_PID" || fail "re-parked wait exited nonzero"
WAIT_PID=""
[ "$(json_field event "$TMP/wait2.json")" = "comments" ] || fail "re-parked wait printed no comments event"
[ "$(json_field batch "$TMP/wait2.json")" = "b2" ] || fail "expected batch b2 after restart"
ok "kill -9 mid-wait: CLI respawned otacond (pid $DAEMON_PID), re-parked, delivered b2"

# --- 6. two active sessions: refuse with the list — never guess ---------------
otacon start --title "second plan" > "$TMP/start2.json" 2> /dev/null
SID2="$(json_field session "$TMP/start2.json")"
set +e
otacon submit > "$TMP/ambiguous.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "ambiguous submit exited $CODE, expected 1"
[ "$(json_field error.code "$TMP/ambiguous.json")" = "E_AMBIGUOUS_SESSION" ] || fail "expected E_AMBIGUOUS_SESSION"
[ "$(json_field 'error.sessions.length' "$TMP/ambiguous.json")" = "2" ] || fail "refusal did not list both sessions"
grep -q "$SID" "$TMP/ambiguous.json" || fail "refusal list missing $SID"
grep -q "$SID2" "$TMP/ambiguous.json" || fail "refusal list missing $SID2"
ok "two active sessions in the repo: refused with the candidate list"

# --- 7. version mismatch: stale otacond restarted in place --------------------
# Replace the real daemon with a fake stale otacond (health says 0.0.1, exits
# on POST /api/shutdown); any CLI command must restart it to the CLI's version.
curl -s -X POST "$BASE/api/shutdown" > /dev/null
for _ in $(seq 1 50); do
  kill -0 "$DAEMON_PID" 2>/dev/null || { DAEMON_PID=""; break; }
  sleep 0.1
done
[ -z "$DAEMON_PID" ] || fail "daemon did not exit before the stale-restart check"
node -e '
const http = require("http");
const srv = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/health")
    return res.end(JSON.stringify({ app: "otacond", version: "0.0.1", pid: process.pid }));
  if (req.method === "POST" && req.url === "/api/shutdown") {
    res.end(JSON.stringify({ ok: true }));
    return setTimeout(() => process.exit(0), 50);
  }
  res.statusCode = 404; res.end("{}");
});
srv.listen(Number(process.env.OTACON_PORT), "127.0.0.1");
' &
STALE_PID=$!
# Poll until the fake daemon answers as 0.0.1 — a fixed sleep flakes on slow
# machines: if the CLI probes before the fake binds, it sees "down", spawns a
# real otacond, and the restart notice this check greps for is never emitted.
STALE_UP=""
for _ in $(seq 1 50); do
  if curl -sf --max-time 1 "$BASE/api/health" > "$TMP/stale-health.json" 2>/dev/null \
    && [ "$(json_field version "$TMP/stale-health.json")" = "0.0.1" ]; then
    STALE_UP=1
    break
  fi
  sleep 0.1
done
[ -n "$STALE_UP" ] || fail "fake stale otacond never started listening"
otacon status > "$TMP/status-restart.json" 2> "$TMP/restart.err" \
  || fail "status exited nonzero across the stale-daemon restart ($(cat "$TMP/restart.err"))"
grep -q "restarting stale otacond 0.0.1" "$TMP/restart.err" || fail "no restart notice on stderr"
NEWV="$(json_field daemon.version "$TMP/status-restart.json")"
[ "$NEWV" != "0.0.1" ] || fail "status still talked to the stale daemon"
curl -sf "$BASE/api/health" > "$TMP/health3.json" || fail "no daemon up after the restart"
[ "$(json_field version "$TMP/health3.json")" = "$NEWV" ] || fail "spawned daemon version mismatch"
DAEMON_PID="$(json_field pid "$TMP/health3.json")"
if kill -0 "$STALE_PID" 2>/dev/null; then fail "stale daemon survived the restart"; fi
STALE_PID=""
ok "stale otacond 0.0.1 was shut down and $NEWV spawned in its place"

echo "# e2e-cli: all $PASS checks passed"
