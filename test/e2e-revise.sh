#!/usr/bin/env bash
# End-to-end exercise of the M3 revise loop against the real built artifact
# (DESIGN.md §6 step 5, §9): submit r1, flush a comment batch over curl (the
# phone's path), resubmit WITHOUT resolutions → 422 carrying the L5 errors,
# resubmit WITH resolutions + changelog → r2 accepted, the thread resolved,
# the diff endpoint reporting changed sections vs the last-reviewed revision,
# and a thread whose quoted text r2 deleted landing in the orphaned state.
# Hermetic: temp OTACON_HOME, temp git repo, ephemeral port.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
export OTACON_HOME="$TMP/home"
REPO="$TMP/repo"
mkdir -p "$OTACON_HOME" "$REPO"
printf '{"notifications":{"desktop":false}}' > "$OTACON_HOME/config.json" # hermetic: no real desktop banners

BASE="" # set once the port is picked; the trap may fire before that (set -u)
DAEMON_PID=""
PASS=0
cleanup() {
  [ -n "$BASE" ] && curl -s -X POST "$BASE/api/shutdown" > /dev/null 2>&1 || true
  [ -n "$DAEMON_PID" ] && kill -9 "$DAEMON_PID" 2>/dev/null || true
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

# --- 1. start a session and submit r1 ----------------------------------------
cd "$REPO"
git init -q -b main .
otacon start --title "revise loop" > "$TMP/start.json" 2> /dev/null
SID="$(json_field session "$TMP/start.json")"
[[ "$SID" == otc_* ]] || fail "start printed no otc_ session id"
DAEMON_PID="$(curl -sf "$BASE/api/health" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).pid")"
sed "s/otc_test01/$SID/" "$ROOT/test/fixtures/valid-plan.md" > ".otacon/$SID/plan.md"
otacon submit > "$TMP/r1.json"
[ "$(json_field revision "$TMP/r1.json")" = "1" ] || fail "expected revision 1"
ok "session $SID started; r1 accepted"

# --- 2. flush a comment batch (two threads: one survives r2, one orphans) -----
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' -d '{
  "items": [
    {"anchor": {"section": "decisions", "exact": "Sessions table stays until phase 3"}, "body": "still true?"},
    {"anchor": {"section": "phase-1", "exact": "key rotation"}, "body": "what about rotation cadence?"}
  ]}' > "$TMP/batch.json"
[ "$(json_field batch "$TMP/batch.json")" = "b1" ] || fail "expected batch b1"
otacon status > "$TMP/status.json"
[ "$(json_field 'sessions[0].status' "$TMP/status.json")" = "revising" ] || fail "batch did not flip status to revising"
# Flushing the batch implicitly marks r1 reviewed (the diff baseline).
curl -s "$BASE/api/sessions/$SID" > "$TMP/detail.json"
[ "$(json_field lastReviewedRevision "$TMP/detail.json")" = "1" ] || fail "comment flush did not mark r1 reviewed"
ok "comment batch b1 (t1, t2) flushed; r1 marked last-reviewed"

# --- 3. resubmit WITHOUT resolutions: 422 carrying the L5 errors --------------
# r2 edits phase 1 and deletes t2's quoted text ("key rotation").
sed -e 's/key rotation\.$/scheduled re-issue./' \
    -e 's/Unit tests cover issuance and/Unit tests cover issuance, expiry, and/' \
    ".otacon/$SID/plan.md" > "$TMP/r2.md"
cp "$TMP/r2.md" ".otacon/$SID/plan.md"
set +e
otacon submit > "$TMP/reject.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "resubmit without resolutions exited $CODE, expected 1"
[ "$(json_field ok "$TMP/reject.json")" = "false" ] || fail "L5 reject did not say ok:false"
grep -q '"E_THREAD_UNRESOLVED"' "$TMP/reject.json" || fail "no E_THREAD_UNRESOLVED in the 422"
grep -q '"E_CHANGELOG_MISSING"' "$TMP/reject.json" || fail "no E_CHANGELOG_MISSING in the 422"
grep -q '"rule":"L5"' "$TMP/reject.json" || fail "422 errors are not rule L5"
curl -s "$BASE/api/sessions/$SID" > "$TMP/detail2.json"
[ "$(json_field revision "$TMP/detail2.json")" = "1" ] || fail "rejected resubmit stored a revision"
ok "resubmit without resolutions rejected 422 with L5 errors (nothing stored)"

# --- 4. resubmit WITH resolutions + changelog: r2 accepted, thread resolved ---
cat > "$TMP/res.json" <<'JSON'
{
  "changelog": "Replaced key rotation with scheduled re-issue; verification now covers expiry.",
  "threads": {
    "t1": "Yes — the sessions table still backs rollback until phase 3.",
    "t2": "Dropped rotation entirely in favor of scheduled re-issue; see Phase 1."
  }
}
JSON
otacon submit --resolutions "$TMP/res.json" > "$TMP/r2.json"
[ "$(json_field ok "$TMP/r2.json")" = "true" ] || fail "resubmit with resolutions failed"
[ "$(json_field revision "$TMP/r2.json")" = "2" ] || fail "expected revision 2"
[ "$(json_field 'resolved.length' "$TMP/r2.json")" = "2" ] || fail "submit response did not list resolutions"
curl -s "$BASE/api/sessions/$SID/threads" > "$TMP/threads.json"
node -e '
const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const t1 = data.threads.find((t) => t.id === "t1");
if (!t1?.resolution || t1.resolution.revision !== 2) process.exit(1);
if (t1.anchorState === "orphaned") process.exit(2); // t1 quote survives r2
' "$TMP/threads.json" || fail "t1 is not resolved-and-anchored after r2"
ok "r2 accepted with resolutions + changelog; t1 resolved and still anchored"

# --- 5. the changelog is stored and served with the revision ------------------
curl -s -H 'accept: application/json' "$BASE/api/sessions/$SID/revisions/2" > "$TMP/rev2.json"
json_field changelog "$TMP/rev2.json" | grep -q "scheduled re-issue" || fail "revision payload has no changelog"
[ "$(json_field changelog "$TMP/rev2.json" | head -c4)" != "null" ] || fail "changelog is null"
curl -s -H 'accept: application/json' "$BASE/api/sessions/$SID/revisions/1" > "$TMP/rev1.json"
[ "$(node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).changelog === null" < "$TMP/rev1.json")" = "true" ] \
  || fail "r1 should have a null changelog"
ok "changelog persisted on r2 and exposed in the revision payload"

# --- 6. diff defaults to last-reviewed (r1) and flags the changed section -----
curl -s "$BASE/api/sessions/$SID/diff" > "$TMP/diff.json"
[ "$(json_field from "$TMP/diff.json")" = "1" ] || fail "diff did not default from= to last-reviewed r1"
[ "$(json_field to "$TMP/diff.json")" = "2" ] || fail "diff did not default to= to r2"
node -e '
const diff = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const byId = Object.fromEntries(diff.sections.map((s) => [s.id, s]));
if (byId["phase-1"]?.status !== "changed") process.exit(1);
if (!byId["phase-1"].hunks.length) process.exit(2);
const adds = byId["phase-1"].hunks.flatMap((h) => h.lines).filter((l) => l.op === "add");
if (!adds.some((l) => l.text.includes("scheduled re-issue"))) process.exit(3);
if (byId["summary"]?.status !== "unchanged" || byId["summary"].hunks.length) process.exit(4);
' "$TMP/diff.json" || fail "diff vs last-reviewed did not flag phase-1 as changed (and summary unchanged)"
# An explicit baseline overrides: r2 vs r2 is all-unchanged.
curl -s "$BASE/api/sessions/$SID/diff?from=2" > "$TMP/diff22.json"
node -e '
const diff = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (!diff.sections.every((s) => s.status === "unchanged")) process.exit(1);
' "$TMP/diff22.json" || fail "?from=2 did not override the baseline"
ok "diff defaults to last-reviewed baseline; ?from= selects another"

# --- 7. the thread whose quote r2 deleted is orphaned, never dropped ----------
node -e '
const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const t2 = data.threads.find((t) => t.id === "t2");
if (!t2) process.exit(1); // never dropped
if (t2.anchorState !== "orphaned") process.exit(2);
if (!t2.resolution) process.exit(3); // resolved AND orphaned are independent
' "$TMP/threads.json" || fail "t2 (quote deleted in r2) is not orphaned"
ok "t2's quote vanished in r2: thread orphaned, still resolved, never dropped"

# --- 8. explicit mark-reviewed moves the default baseline ---------------------
curl -s -X POST "$BASE/api/sessions/$SID/reviewed" -H 'content-type: application/json' -d '{}' > "$TMP/reviewed.json"
[ "$(json_field lastReviewedRevision "$TMP/reviewed.json")" = "2" ] || fail "POST /reviewed did not mark r2"
curl -s "$BASE/api/sessions/$SID/diff" > "$TMP/diff3.json"
[ "$(json_field from "$TMP/diff3.json")" = "2" ] || fail "default baseline did not follow mark-reviewed"
ok "POST /reviewed marked r2; the default diff baseline followed"

echo "# e2e-revise: all $PASS checks passed"
