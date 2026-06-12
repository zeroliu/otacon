#!/usr/bin/env bash
# End-to-end exercise of the M4 grill + approve flow against the real built
# artifact (DESIGN.md §6 step 6, §8): otacon ask posts a question card, a curl
# answer wakes the parked wait, lint L3 rejects citations of q ids missing
# from the transcript and accepts real ones, approve refuses 409 on unresolved
# threads, a forced approve writes docs/plans/<date>-<slug>.md with the
# Interview appended and ends the session (mutations refused), and a --quick
# session downgrades L3 to warnings. Hermetic: temp OTACON_HOME, temp git
# repo, ephemeral port.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
export OTACON_HOME="$TMP/home"
REPO="$TMP/repo"
mkdir -p "$OTACON_HOME" "$REPO"

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

# --- 1. start; ask a chip question and a free-text one -----------------------
cd "$REPO"
git init -q -b main .
otacon start --title "grill loop" > "$TMP/start.json" 2> /dev/null
SID="$(json_field session "$TMP/start.json")"
[[ "$SID" == otc_* ]] || fail "start printed no otc_ session id"
DAEMON_PID="$(curl -sf "$BASE/api/health" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).pid")"
otacon ask --question "RS256 or HS256?" --options "RS256|HS256" --recommend RS256 > "$TMP/ask1.json"
[ "$(json_field ok "$TMP/ask1.json")" = "true" ] || fail "ask did not report ok"
[ "$(json_field id "$TMP/ask1.json")" = "q1" ] || fail "first ask should mint q1"
otacon ask --question "Anything out of scope?" > "$TMP/ask2.json"
[ "$(json_field id "$TMP/ask2.json")" = "q2" ] || fail "second ask should mint q2"
curl -s "$BASE/api/sessions/$SID/transcript" > "$TMP/transcript.json"
node -e '
const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).transcript;
if (t.length !== 2 || t[0].id !== "q1" || t[0].recommend !== "RS256") process.exit(1);
if (t[0].options.join("|") !== "RS256|HS256" || t[1].options !== undefined) process.exit(2);
' "$TMP/transcript.json" || fail "transcript does not carry both questions"
ok "otacon ask minted q1 (chips + recommend) and q2 (free text) into the transcript"

# --- 2. a curl answer wakes the parked wait with the answer event ------------
otacon wait --timeout 30 > "$TMP/wait1.json" &
WAIT_PID=$!
sleep 1
curl -s -X POST "$BASE/api/sessions/$SID/answers" -H 'content-type: application/json' \
  -d '{"question":"q1","choice":"RS256","text":"rotation story is simpler"}' > "$TMP/ans1.json"
[ "$(json_field ok "$TMP/ans1.json")" = "true" ] || fail "POST /answers did not report ok"
wait "$WAIT_PID" || fail "parked wait exited nonzero"
WAIT_PID=""
[ "$(json_field event "$TMP/wait1.json")" = "answer" ] || fail "wait did not print the answer event"
[ "$(json_field question "$TMP/wait1.json")" = "q1" ] || fail "answer event names the wrong question"
[ "$(json_field choice "$TMP/wait1.json")" = "RS256" ] || fail "answer event missing the choice"
[ "$(json_field text "$TMP/wait1.json")" = "rotation story is simpler" ] || fail "answer event missing the text"
curl -s -X POST "$BASE/api/sessions/$SID/answers" -H 'content-type: application/json' \
  -d '{"question":"q2","text":"keep revocation out"}' > /dev/null
otacon wait --timeout 10 > "$TMP/wait2.json"
[ "$(json_field question "$TMP/wait2.json")" = "q2" ] || fail "q2's answer never arrived"
ok "answers landed on the transcript and woke the parked wait as answer events"

# --- 3. L3: citing a q id missing from the transcript rejects 422 -------------
sed -e "s/otc_test01/$SID/" \
    -e "s/- D1: RS256 over HS256 \[assumed\]/- D1: RS256 over HS256 ← q9/" \
    "$ROOT/test/fixtures/valid-plan.md" > ".otacon/$SID/plan.md"
set +e
otacon submit > "$TMP/l3reject.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "submit citing q9 exited $CODE, expected 1"
grep -q '"E_UNKNOWN_QUESTION_CITED"' "$TMP/l3reject.json" || fail "no E_UNKNOWN_QUESTION_CITED in the 422"
grep -q '"rule":"L3"' "$TMP/l3reject.json" || fail "422 errors are not rule L3"
ok "a decision citing nonexistent q9 was rejected 422 with L3 errors"

# --- 4. D-entries citing the real q ids (one [assumed]) lint clean ------------
sed -e "s/otc_test01/$SID/" \
    -e "s/- D1: RS256 over HS256 \[assumed\]/- D1: RS256 over HS256 ← q1/" \
    -e "s/- D2: Sessions table stays until phase 3 \[assumed\]/- D2: Revocation deferred ← q2\n- D3: Sessions table stays until phase 3 [assumed]/" \
    "$ROOT/test/fixtures/valid-plan.md" > ".otacon/$SID/plan.md"
otacon submit > "$TMP/r1.json"
[ "$(json_field revision "$TMP/r1.json")" = "1" ] || fail "expected revision 1"
ok "r1 accepted: decisions trace to the real q1/q2 (plus one [assumed])"

# --- 5. comment → resolve; second open comment blocks approve with 409 --------
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' \
  -d '{"items":[{"anchor":{"section":"phase-1"},"body":"tighten the goal"}]}' > /dev/null
otacon wait --timeout 10 > /dev/null # drain the comments event
cat > "$TMP/res.json" <<'JSON'
{"changelog": "Tightened phase 1 per t1.", "threads": {"t1": "Goal now names the issuer."}}
JSON
otacon submit --resolutions "$TMP/res.json" > "$TMP/r2.json"
[ "$(json_field revision "$TMP/r2.json")" = "2" ] || fail "expected revision 2"
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' \
  -d '{"items":[{"anchor":null,"body":"still pondering the rollout"}]}' > /dev/null
HTTP=$(curl -s -o "$TMP/approve409.json" -w '%{http_code}' \
  -X POST "$BASE/api/sessions/$SID/approve" -H 'content-type: application/json' -d '{}')
[ "$HTTP" = "409" ] || fail "approve with an open thread answered $HTTP, expected 409"
[ "$(json_field error.code "$TMP/approve409.json")" = "E_UNRESOLVED_THREADS" ] || fail "wrong 409 code"
[ "$(json_field unresolved "$TMP/approve409.json")" = "1" ] || fail "409 should count 1 unresolved thread"
ok "t1 resolved via resubmit; open t2 blocked approve with 409 + count"

# --- 6. forced approve writes the artifact and delivers the approved event ----
otacon wait --timeout 30 > "$TMP/wait3.json" &
WAIT_PID=$!
sleep 1
HTTP=$(curl -s -o "$TMP/approved.json" -w '%{http_code}' \
  -X POST "$BASE/api/sessions/$SID/approve" -H 'content-type: application/json' -d '{"force":true}')
[ "$HTTP" = "200" ] || fail "forced approve answered $HTTP"
ART_PATH="$(json_field path "$TMP/approved.json")"
[[ "$ART_PATH" == docs/plans/*-grill-loop.md ]] || fail "unexpected artifact path $ART_PATH"
wait "$WAIT_PID" || fail "parked wait exited nonzero"
WAIT_PID=""
# wait drains the comments event for t2 first; the approved event follows.
if [ "$(json_field event "$TMP/wait3.json")" = "comments" ]; then
  otacon wait --timeout 10 --session "$SID" > "$TMP/wait3.json"
fi
[ "$(json_field event "$TMP/wait3.json")" = "approved" ] || fail "wait did not deliver the approved event"
[ "$(json_field path "$TMP/wait3.json")" = "$ART_PATH" ] || fail "approved event path mismatch"
[ -f "$REPO/$ART_PATH" ] || fail "artifact file missing at $ART_PATH"
grep -q '^status: approved$' "$REPO/$ART_PATH" || fail "artifact frontmatter is not approved"
grep -q '^revision: 2$' "$REPO/$ART_PATH" || fail "artifact frontmatter revision not corrected to 2"
grep -q '^## Interview$' "$REPO/$ART_PATH" || fail "artifact has no Interview section"
grep -q '^### q1 — RS256 or HS256?$' "$REPO/$ART_PATH" || fail "Interview missing q1"
grep -q 'RS256 (recommended) | HS256' "$REPO/$ART_PATH" || fail "Interview missing the option chips"
grep -q '^- Answer: RS256 — rotation story is simpler$' "$REPO/$ART_PATH" || fail "Interview missing q1's answer"
grep -q '^- Answer: keep revocation out$' "$REPO/$ART_PATH" || fail "Interview missing q2's answer"
ok "forced approve wrote $ART_PATH (status approved, Interview appended); wait got the event"

# --- 7. the approved session refuses every further verb -----------------------
set +e
otacon submit > "$TMP/oversubmit.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "submit on the ended session exited $CODE, expected 1"
[ "$(json_field error.code "$TMP/oversubmit.json")" = "E_SESSION_OVER" ] || fail "expected E_SESSION_OVER from the pointer"
HTTP=$(curl -s -o "$TMP/oversubmit2.json" -w '%{http_code}' \
  -X POST "$BASE/api/sessions/$SID/submit" -H 'content-type: text/markdown' \
  --data-binary "@.otacon/$SID/plan.md")
[ "$HTTP" = "409" ] || fail "daemon-side submit on approved session answered $HTTP, expected 409"
[ "$(json_field error.code "$TMP/oversubmit2.json")" = "E_SESSION_OVER" ] || fail "daemon 409 has the wrong code"
set +e
otacon ask --question "one more?" --session "$SID" > "$TMP/overask.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "ask on the ended session exited $CODE, expected 1"
[ "$(json_field error.code "$TMP/overask.json")" = "E_SESSION_OVER" ] || fail "ask did not refuse with E_SESSION_OVER"
ok "the approved session is over: CLI and daemon refuse submit/ask with E_SESSION_OVER"

# --- 8. a --quick session downgrades L3 to warnings ----------------------------
otacon start --quick --title "quick grill" > "$TMP/quick.json" 2> /dev/null
QSID="$(json_field session "$TMP/quick.json")"
sed -e "s/otc_test01/$QSID/" \
    -e "s/- D1: RS256 over HS256 \[assumed\]/- D1: RS256 over HS256/" \
    "$ROOT/test/fixtures/valid-plan.md" > ".otacon/$QSID/plan.md"
otacon submit > "$TMP/quicksubmit.json"
[ "$(json_field ok "$TMP/quicksubmit.json")" = "true" ] || fail "quick submit with an untraced decision failed"
node -e '
const body = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const w = body.warnings.find((x) => x.code === "E_DECISION_UNTRACED");
if (!w || w.severity !== "warning" || w.rule !== "L3") process.exit(1);
' "$TMP/quicksubmit.json" || fail "quick submit did not downgrade L3 to a warning"
ok "--quick session accepted the untraced decision with an L3 warning"

echo "# e2e-grill: all $PASS checks passed"
