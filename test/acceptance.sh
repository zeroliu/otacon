#!/usr/bin/env bash
# bun run accept — the FINAL end-to-end acceptance test for install/update:
# "install otacon on a repo and test the plan functionalities e2e". One
# hermetic script, run entirely against the BUILT artifact (node
# dist/cli/main.js — never the TS source), simulating BOTH actors: the human
# (curl, the phone's path) and the coding agent (the CLI, driven as an agent's
# Bash tool would). It proves the install/update promise against what actually ships.
#
# Acts:
#   INSTALL   install --agent claude --hooks → SKILL.md + Stop hook + merged
#             settings.json; doctor → green JSON (tailscale absent → warn).
#   LOOP      the full agent/reviewer loop on the real auto-spawned daemon:
#             start → grill (ask/answer) → draft (lint reject, then accept) →
#             review (comment batch) → revise (L5 reject, then resolve) →
#             approve (home archive + untracked project copy, otacon never
#             commits) → post-approve refusal → clean (archive + registry prune).
#   INVARIANT structural grep of dist/ for any model/LLM network call (zero model-network-call invariant).
#
# Hermetic: temp HOME, temp OTACON_HOME, temp OTACON_PORT, a fresh `git init`
# temp repo as the "user's project", NO_PROXY for loopback, OTACON_TAILSCALE
# pinned away from any real tailscale. trap-cleanup of every temp dir and
# background child even on failure; polling instead of brittle fixed sleeps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
export HOME="$TMP/home"
export OTACON_HOME="$TMP/otacon-home"
export OTACON_TAILSCALE="/nonexistent-tailscale" # never touch a real tailnet
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
REPO="$TMP/project" # the "user's project" git repo
mkdir -p "$HOME" "$OTACON_HOME" "$REPO"
printf '{"notifications":{"desktop":false}}' > "$OTACON_HOME/config.json" # hermetic: no real desktop banners

BASE="" # set once the port is picked; the trap may fire before that (set -u)
DAEMON_PID=""
WAIT_PID=""
PASS=0
cleanup() {
  [ -n "$WAIT_PID" ] && kill -9 "$WAIT_PID" 2>/dev/null || true
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
echo "# building the shipped artifact (testing dist/, never the TS source)"
(cd "$ROOT" && bun run build > /dev/null)

PORT="$(free_port)"
export OTACON_PORT="$PORT"
BASE="http://127.0.0.1:$PORT"
# The agent invokes the CLI exactly like this — the built JS on plain Node.
otacon() { node "$ROOT/dist/cli/main.js" "$@"; }

echo "# ── ACT 1: INSTALL (as the user) ──────────────────────────────────────"

SKILL="$HOME/.claude/skills/otacon/SKILL.md"
HOOK="$HOME/.claude/hooks/otacon-stop.sh"
SETTINGS="$HOME/.claude/settings.json"

# --- 1. install --agent claude --hooks writes the wrapper, hook, settings -----
otacon install --agent claude --hooks > "$TMP/install.json" 2> /dev/null
[ "$(json_field ok "$TMP/install.json")" = "true" ] || fail "install did not report ok"
[ "$(json_field hooks.registered "$TMP/install.json")" = "true" ] || fail "--hooks did not register"
[ -f "$SKILL" ] || fail "SKILL.md missing at $SKILL"
grep -q 'managed by `otacon install`' "$SKILL" || fail "SKILL.md missing the managed marker"
for needle in 'otacon start --title' 'otacon ask --question' 'otacon wait --timeout 540' \
  'otacon submit --resolutions resolutions.json' 'Never end your turn'; do
  grep -q "$needle" "$SKILL" || fail "SKILL.md missing protocol text: $needle"
done
[ -x "$HOOK" ] || fail "Stop hook script missing or not executable at $HOOK"
grep -q '"decision":"block"' "$HOOK" || fail "hook script lacks the block decision JSON"
# settings.json gained an additive Stop hook wired to the script.
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const stop = s.hooks?.Stop;
if (!Array.isArray(stop) || stop.length !== 1) process.exit(1);
if (stop[0].hooks[0].command !== process.argv[2]) process.exit(2);
' "$SETTINGS" "$HOOK" || fail "settings.json Stop hook not merged/miswired"
ok "install --agent claude --hooks wrote SKILL.md + Stop hook + merged settings.json"

# --- 2. doctor reports green JSON; tailscale absent → graceful warning ---------
otacon doctor > "$TMP/doctor.json" 2> /dev/null || fail "doctor exited nonzero on a healthy setup"
[ "$(json_field ok "$TMP/doctor.json")" = "true" ] || fail "doctor ok should be true"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const get = (n) => r.checks.find((c) => c.name === n);
if (get("node").status !== "ok") process.exit(1);
if (get("daemon").status !== "ok" || !get("daemon").detail.includes("otacond")) process.exit(2);
if (get("wrapper-claude").status !== "ok" || get("stop-hook").status !== "ok") process.exit(3);
if (get("tailscale").status !== "warn") process.exit(4); // absent → graceful warn, not fail
if (r.checks.some((c) => c.status === "fail")) process.exit(5);
' "$TMP/doctor.json" || fail "doctor green report has wrong check statuses"
ok "doctor green: node/daemon/wrapper/stop-hook ok; absent tailscale a warning (not a failure)"

echo "# ── ACT 2: THE FULL PLAN LOOP (agent + human) ─────────────────────────"

# --- 3. start in the user's repo: .otacon dir, registry, URL, no .gitignore touch
cd "$REPO"
git init -q -b main .
git config user.email accept@otacon.test
git config user.name "Otacon Accept"
printf 'node_modules/\n' > .gitignore
git add .gitignore && git commit -q -m "initial"
otacon start --title "acceptance-demo" > "$TMP/start.json" 2> "$TMP/start.err"
SID="$(json_field session "$TMP/start.json")"
[[ "$SID" == otc_* ]] || fail "start printed no otc_ session id"
DAEMON_PID="$(curl -sf "$BASE/api/health" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).pid")"
[ -d "$REPO/.otacon/$SID" ] || fail ".otacon/<session> dir not created"
# otacon manages no .gitignore: the user's file is left exactly as written and
# no notice is emitted (DECISIONS.md "otacon manages no .gitignore").
[ "$(cat .gitignore)" = "node_modules/" ] || fail "start modified .gitignore"
if grep -q 'appended' "$TMP/start.err"; then fail "start emitted a .gitignore notice"; fi
grep -q "$SID" "$OTACON_HOME/registry.json" || fail "session missing from the registry"
json_field url "$TMP/start.json" | grep -q "/s/$SID" || fail "start printed no review URL"
ok "start: .otacon created, .gitignore left untouched, registered, review URL printed"

# --- 4. grill: ask a chip question; a parked wait is fed the phone's answer ----
otacon ask --question "RS256 or HS256 for token signing?" \
  --options "RS256|HS256" --recommend RS256 > "$TMP/ask.json"
[ "$(json_field id "$TMP/ask.json")" = "q1" ] || fail "first ask should mint q1"
otacon wait --timeout 30 > "$TMP/grill-wait.json" &
WAIT_PID=$!
# The phone answers the card over curl (the human's path). The daemon queues
# the answer and the wait drains it whether or not it was mid-park (at-least-
# once delivery, review loop and daemon API) — the brief sleep just lets it park first.
sleep 0.5
curl -s -X POST "$BASE/api/sessions/$SID/answers" -H 'content-type: application/json' \
  -d '{"question":"q1","choice":"RS256","text":"verifiers only need the public key"}' > /dev/null
wait "$WAIT_PID" || fail "parked grill wait exited nonzero"
WAIT_PID=""
[ "$(json_field event "$TMP/grill-wait.json")" = "answer" ] || fail "grill wait did not get the answer event"
[ "$(json_field question "$TMP/grill-wait.json")" = "q1" ] || fail "answer event names the wrong question"
[ "$(json_field choice "$TMP/grill-wait.json")" = "RS256" ] || fail "answer event missing the choice"
ok "grill: ask minted q1; a parked wait received the phone's RS256 answer over curl"

# --- 5. draft: an INVALID plan is lint-rejected with machine-readable errors ---
# Deliberately invalid: missing required sections (L1) + an over-budget Summary
# (L2) + a decision citing a q id that does not exist in the transcript (L3).
cat > ".otacon/$SID/plan.md" <<EOF
---
title: acceptance-demo
session: $SID
revision: 1
status: in_review
created: 2026-06-13
---

# acceptance-demo

## Summary

Line one of a summary that runs long on purpose.
Line two.
Line three.
Line four.
Line five.
Line six is over the five-line budget so L2 must fire here.

## Decisions

- D1: RS256 over HS256 ← q9
EOF
set +e
otacon submit > "$TMP/lint-reject.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "invalid submit exited $CODE, expected 1"
[ "$(json_field ok "$TMP/lint-reject.json")" = "false" ] || fail "lint reject did not say ok:false"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const rules = new Set((r.errors ?? []).map((e) => e.rule));
const codes = new Set((r.errors ?? []).map((e) => e.code));
if (!rules.has("L1")) process.exit(1); // missing sections / phase fields
if (!rules.has("L2")) process.exit(2); // summary over budget
if (!codes.has("E_UNKNOWN_QUESTION_CITED")) process.exit(3); // L3 citation of q9
' "$TMP/lint-reject.json" || fail "lint reject lacked the L1/L2/L3-citation errors"
ok "draft: deliberately invalid plan rejected exit 1 with machine-readable L1/L2/L3 errors"

# --- 6. draft: the schema-valid plan stores revision 1, status in_review ------
# Decisions cite the REAL q1 (+ one [assumed]) — exactly what L3 enforces.
sed -e "s/otc_test01/$SID/" \
    -e "s/- D1: RS256 over HS256 \[assumed\]/- D1: RS256 over HS256 ← q1/" \
    "$ROOT/test/fixtures/valid-plan.md" > ".otacon/$SID/plan.md"
otacon submit > "$TMP/r1.json"
[ "$(json_field ok "$TMP/r1.json")" = "true" ] || fail "valid submit did not say ok"
[ "$(json_field revision "$TMP/r1.json")" = "1" ] || fail "expected revision 1"
[ "$(json_field status "$TMP/r1.json")" = "in_review" ] || fail "expected in_review"
[ -f "$REPO/.otacon/$SID/r1.md" ] || fail "r1.md snapshot not stored"
ok "draft: valid plan (D1 ← q1, D2 [assumed]) stored as revision 1, status in_review"

# --- 7. review: a parked wait is fed a comment batch from the phone ------------
otacon wait --timeout 30 > "$TMP/review-wait.json" &
WAIT_PID=$!
sleep 0.5 # let the wait park before the phone flushes the batch
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' -d '{
  "items": [
    {"anchor": {"section": "phase-1", "exact": "key rotation"}, "body": "rotation cadence?"}
  ]}' > /dev/null
wait "$WAIT_PID" || fail "parked review wait exited nonzero"
WAIT_PID=""
[ "$(json_field event "$TMP/review-wait.json")" = "comments" ] || fail "review wait did not get comments"
[ "$(json_field batch "$TMP/review-wait.json")" = "b1" ] || fail "expected batch b1"
[ "$(json_field 'items[0].anchor.section' "$TMP/review-wait.json")" = "phase-1" ] \
  || fail "comment event carried the wrong anchor section"
[ "$(json_field 'items[0].thread' "$TMP/review-wait.json")" = "t1" ] || fail "expected thread t1"
ok "review: a parked wait received the phone's comment batch b1 anchored to phase-1 (t1)"

# --- 8. revise: resubmit WITHOUT resolutions → 422 L5 (nothing stored) ---------
# r2 edits phase 1 and deletes t1's quoted text ("key rotation").
sed -e 's/key rotation\.$/scheduled re-issue./' ".otacon/$SID/plan.md" > "$TMP/r2.md"
cp "$TMP/r2.md" ".otacon/$SID/plan.md"
set +e
otacon submit > "$TMP/l5-reject.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "resubmit without resolutions exited $CODE, expected 1"
grep -q '"E_THREAD_UNRESOLVED"' "$TMP/l5-reject.json" || fail "no E_THREAD_UNRESOLVED (L5) in the 422"
grep -q '"E_CHANGELOG_MISSING"' "$TMP/l5-reject.json" || fail "no E_CHANGELOG_MISSING (L5) in the 422"
grep -q '"rule":"L5"' "$TMP/l5-reject.json" || fail "422 errors are not rule L5"
curl -s "$BASE/api/sessions/$SID" > "$TMP/detail-after-reject.json"
[ "$(json_field revision "$TMP/detail-after-reject.json")" = "1" ] || fail "rejected resubmit stored a revision"
ok "revise: resubmit without resolutions rejected 422 with L5 errors; r1 still latest"

# --- 9. revise: WITH resolutions.json → r2, thread resolved, diff vs reviewed --
cat > "$TMP/res.json" <<'JSON'
{
  "changelog": "Replaced key rotation with scheduled re-issue; addressed the cadence comment.",
  "threads": { "t1": "Dropped rotation in favor of scheduled re-issue; see Phase 1." }
}
JSON
otacon submit --resolutions "$TMP/res.json" > "$TMP/r2.json"
[ "$(json_field ok "$TMP/r2.json")" = "true" ] || fail "resubmit with resolutions failed"
[ "$(json_field revision "$TMP/r2.json")" = "2" ] || fail "expected revision 2"
curl -s "$BASE/api/sessions/$SID/threads" > "$TMP/threads.json"
node -e '
const data = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const t1 = data.threads.find((t) => t.id === "t1");
if (!t1?.resolution || t1.resolution.revision !== 2) process.exit(1);
' "$TMP/threads.json" || fail "t1 is not resolved at r2 after resubmit"
# Diff defaults to last-reviewed (r1, marked by the comment flush) → r2; phase-1
# changed vs unchanged summary.
curl -s "$BASE/api/sessions/$SID/diff" > "$TMP/diff.json"
[ "$(json_field from "$TMP/diff.json")" = "1" ] || fail "diff did not default from= to last-reviewed r1"
[ "$(json_field to "$TMP/diff.json")" = "2" ] || fail "diff did not default to= to r2"
node -e '
const diff = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const byId = Object.fromEntries(diff.sections.map((s) => [s.id, s]));
if (byId["phase-1"]?.status !== "changed" || !byId["phase-1"].hunks.length) process.exit(1);
if (byId["summary"]?.status !== "unchanged" || byId["summary"].hunks.length) process.exit(2);
' "$TMP/diff.json" || fail "diff vs last-reviewed did not flag phase-1 changed (summary unchanged)"
ok "revise: r2 stored with resolutions+changelog; t1 resolved; diff flags phase-1 vs reviewed r1"

# --- 10. approve: unresolved-thread path is covered; resolved → Save write-out -
# Sanity: an extra open comment makes approve refuse 409 (the warned path). The
# UI hits this, warns, then forces — so we exercise both the refusal and the
# forced write. We drain the queued comment with its own wait first, so the
# approve wait below has a clean queue and the FIFO ordering is deterministic.
curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' \
  -d '{"items":[{"anchor":null,"body":"one more thought"}]}' > /dev/null
otacon wait --timeout 10 > "$TMP/extra-comment.json"
[ "$(json_field event "$TMP/extra-comment.json")" = "comments" ] || fail "extra comment not drained"
HTTP=$(curl -s -o "$TMP/approve409.json" -w '%{http_code}' \
  -X POST "$BASE/api/sessions/$SID/approve" -H 'content-type: application/json' -d '{}')
[ "$HTTP" = "409" ] || fail "approve with an open thread answered $HTTP, expected 409"
[ "$(json_field error.code "$TMP/approve409.json")" = "E_UNRESOLVED_THREADS" ] || fail "wrong 409 code"
[ "$(json_field unresolved "$TMP/approve409.json")" = "1" ] || fail "409 should count 1 unresolved thread"
# Now approve (force, as the UI does after the warning) with a parked wait — the
# agent's side that hears the approval (a plain Save: home archive + project
# copy, otacon never commits). Park, then force.
otacon wait --timeout 30 > "$TMP/approve-wait.json" &
WAIT_PID=$!
sleep 0.5 # let the wait park on the (now-empty) queue before approve enqueues
HTTP=$(curl -s -o "$TMP/approved.json" -w '%{http_code}' \
  -X POST "$BASE/api/sessions/$SID/approve" -H 'content-type: application/json' -d '{"force":true}')
[ "$HTTP" = "200" ] || fail "forced approve answered $HTTP"
ART_PATH="$(json_field path "$TMP/approved.json")"
[[ "$ART_PATH" == .otacon/plans/*-acceptance-demo.md ]] || fail "unexpected artifact path $ART_PATH"
HOME_ART="$(json_field home "$TMP/approved.json")"
[[ "$HOME_ART" == "$OTACON_HOME/sessions/$SID/"*-acceptance-demo.md ]] \
  || fail "unexpected home archive path $HOME_ART"
wait "$WAIT_PID" || fail "parked approve wait exited nonzero"
WAIT_PID=""
# Drain forward until the approved event surfaces (any stray queued event first).
for _ in $(seq 1 5); do
  [ "$(json_field event "$TMP/approve-wait.json")" = "approved" ] && break
  otacon wait --timeout 10 --session "$SID" > "$TMP/approve-wait.json"
done
[ "$(json_field event "$TMP/approve-wait.json")" = "approved" ] || fail "wait did not deliver approved"
[ "$(json_field path "$TMP/approve-wait.json")" = "$ART_PATH" ] || fail "approved event path mismatch"
[ "$(json_field home "$TMP/approve-wait.json")" = "$HOME_ART" ] || fail "approved event home mismatch"
[ -f "$REPO/$ART_PATH" ] || fail "project copy missing at $ART_PATH"
grep -q '^status: approved$' "$REPO/$ART_PATH" || fail "artifact frontmatter is not approved"
grep -q '^revision: 2$' "$REPO/$ART_PATH" || fail "artifact revision not corrected to 2"
grep -q '^## Interview$' "$REPO/$ART_PATH" || fail "artifact has no Interview section"
grep -q '^### q1 — RS256 or HS256 for token signing?$' "$REPO/$ART_PATH" || fail "Interview missing q1"
grep -q '^- Answer: RS256 — verifiers only need the public key$' "$REPO/$ART_PATH" \
  || fail "Interview missing q1's answer transcript line"
# The canonical home archive carries the same approved artifact (the permanent store).
[ -f "$HOME_ART" ] || fail "home archive copy missing at $HOME_ART"
grep -q '^status: approved$' "$HOME_ART" || fail "home archive frontmatter is not approved"
grep -q '^## Interview$' "$HOME_ART" || fail "home archive has no Interview section"
ok "approve: 409 on the open thread, then force wrote $ART_PATH + home archive (approved, r2, Interview); wait got it"

# --- 11. otacon never commits; the project copy lands on disk, uncommitted -----
# The model: otacon writes the Save-time project copy under the default
# `.otacon/plans` and NEVER git-commits it — the user controls git. otacon no
# longer ignores `.otacon/` (DECISIONS.md "otacon manages no .gitignore"), so the
# copy is now a git-VISIBLE untracked file; the invariant is only that otacon
# adds no commits and tracks nothing on the user's behalf.
[ -f "$REPO/$ART_PATH" ] || fail "project copy missing on disk at $ART_PATH"
# It was never committed (and never staged): git sees it as untracked.
if git ls-files --error-unmatch "$ART_PATH" > /dev/null 2>&1; then fail "the project copy was committed/tracked by otacon"; fi
[ "$(git status --porcelain -- "$ART_PATH")" = "?? $ART_PATH" ] \
  || fail "project copy is not an untracked working-tree file"
# otacon added no commits: HEAD is still the single 'initial' commit the user made.
[ "$(git rev-list --count HEAD)" = "1" ] || fail "otacon created a commit"
# And it left .gitignore exactly as the user wrote it.
[ "$(cat .gitignore)" = "node_modules/" ] || fail "otacon modified .gitignore"
ok "otacon never committed; the .otacon/plans project copy is on disk, untracked, user-owned"

# --- 12. post-approve: status shows approved; further submit refused -----------
otacon status > "$TMP/status.json"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const s = (r.sessions ?? []).find((x) => x.id === process.argv[2]);
if (!s || s.status !== "approved") process.exit(1);
' "$TMP/status.json" "$SID" || fail "status does not report the session approved"
set +e
otacon submit > "$TMP/oversubmit.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "implicit submit after approve exited $CODE, expected 1"
# No pointer: the approved session is not an active candidate, so an implicit
# submit finds nothing to resolve. The daemon's terminal-state guard
# (E_SESSION_OVER) is reached only with an explicit --session.
[ "$(json_field error.code "$TMP/oversubmit.json")" = "E_NO_SESSION" ] || fail "expected E_NO_SESSION"
set +e
otacon submit --session "$SID" > "$TMP/oversubmit2.json" 2> /dev/null
CODE=$?
set -e
[ "$CODE" = "1" ] || fail "explicit submit on the ended session exited $CODE, expected 1"
[ "$(json_field error.code "$TMP/oversubmit2.json")" = "E_SESSION_OVER" ] || fail "expected E_SESSION_OVER"
ok "post-approve: implicit submit finds no active session; explicit --session is refused (session over)"

# --- 13. clean archives the working state and prunes the registry -------------
otacon clean > "$TMP/clean.json" 2> /dev/null
[ "$(json_field 'cleaned[0].session' "$TMP/clean.json")" = "$SID" ] || fail "clean did not report the session"
[ -d "$REPO/.otacon/archive/$SID" ] || fail "session dir was not archived"
[ -f "$REPO/.otacon/archive/$SID/session.json" ] || fail "archived dir lost its state files"
[ ! -d "$REPO/.otacon/$SID" ] || fail "live session dir still exists after clean"
# clean archives .otacon/<id>/ session dirs but must never touch the project plan
# copy (.otacon/plans) nor the permanent home archive (~/.otacon/sessions/).
[ -f "$REPO/$ART_PATH" ] || fail "clean must never touch the .otacon/plans project copy"
[ -d "$REPO/.otacon/plans" ] || fail "clean archived the .otacon/plans dir (must stay)"
[ -f "$HOME_ART" ] || fail "clean must never touch the home archive (~/.otacon/sessions/)"
curl -s "$BASE/api/sessions" | grep -q "$SID" && fail "registry still lists the cleaned session"
ok "clean: archived .otacon/$SID → .otacon/archive/, pruned the registry, kept the .otacon/plans copy + home archive"

echo "# ── ACT 3: ZERO-API-SPEND INVARIANT (structural) ─────────────────────"

# --- 14. the shipped dist/ never reaches out to a model API (zero model-network-call invariant) ----
# A cheap structural guard: grep the BUILT, runnable artifact for any LLM
# provider host or SDK. The daemon/CLI/linter/UI are pure TypeScript — there
# must be zero. (The UI bundles marked/mermaid etc.; none of those phone home
# to a model.) Scope the host check to the server-side artifact the daemon and
# CLI run, where a stray fetch would actually spend.
SERVER_DIST="$ROOT/dist/cli $ROOT/dist/daemon $ROOT/dist/shared"
if grep -rniE 'api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis|@anthropic-ai|openai|langchain|@ai-sdk|claude-[0-9]' \
  $SERVER_DIST 2>/dev/null; then
  fail "found a model/LLM reference in the shipped server artifact — the zero-spend invariant is broken"
fi
ok "zero-API-spend: no model/LLM provider host or SDK reference in the shipped server artifact"

# --- shutdown -----------------------------------------------------------------
curl -s -X POST "$BASE/api/shutdown" > /dev/null
for _ in $(seq 1 30); do
  kill -0 "$DAEMON_PID" 2>/dev/null || { DAEMON_PID=""; break; }
  sleep 0.1
done

echo
echo "# acceptance: all $PASS checks passed — install and plan review loop"
echo "#   proven end to end against the BUILT artifact (node dist/cli/main.js)."
