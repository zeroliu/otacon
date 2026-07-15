#!/usr/bin/env bash
# End-to-end PR explanation loop through the real built Node CLI and daemon.
# GitHub metadata and the writable worktree are represented by narrow PATH
# fakes, so this proves the process boundary without reading or mutating a real
# pull request. Every other transition crosses the production HTTP API/store.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
export OTACON_HOME="$TMP/home"
REPO="$TMP/repo"
FAKE_BIN="$TMP/bin"
WORKTREES="$TMP/worktrees"
mkdir -p "$OTACON_HOME" "$REPO" "$FAKE_BIN" "$WORKTREES"
printf '{"notifications":{"desktop":false},"update":{"auto":false},"worktree":{"dir":"%s"}}' "$WORKTREES" > "$OTACON_HOME/config.json"

BASE=""
DAEMON_PID=""
PASS=0
HEAD_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
MAIN_SHA="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

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
one_json_line() {
  [ "$(wc -l < "$1" | tr -d ' ')" = "1" ] || fail "$2 did not emit exactly one JSON line"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1" \
    || fail "$2 did not emit valid JSON"
}

render_review_inputs() {
  local revision="$1" snapshot="$2" altitude="$3" report="$4" quiz="$5"
  node -e '
    const fs = require("fs");
    const [reportFixture, quizFixture, reportOut, quizOut, session, revisionRaw, head, snapshot, altitude] = process.argv.slice(1);
    const revision = Number(revisionRaw);
    let report = fs.readFileSync(reportFixture, "utf8")
      .replace(/^session: .*$/m, `session: ${session}`)
      .replace(/^revision: .*$/m, `revision: ${revision}`)
      .replace(/^pr: .*$/m, "pr: github.com/acme/app#42")
      .replace(/^head: .*$/m, `head: ${head}`)
      .replace(/^knowledge-snapshot: .*$/m, `knowledge-snapshot: ${snapshot}`)
      .replace(/^altitude: .*$/m, `altitude: ${altitude}`);
    if (revision > 1) report = report.replace("New evidence changes the next photograph, never the report that produced the evidence.", "Remembered ownership changes the next photograph, never the report that produced the evidence.");
    const quiz = JSON.parse(fs.readFileSync(quizFixture, "utf8"));
    quiz.session = session;
    quiz.revision = revision;
    quiz.headRevision = 1;
    quiz.headSha = head;
    fs.writeFileSync(reportOut, report);
    fs.writeFileSync(quizOut, `${JSON.stringify(quiz, null, 2)}\n`);
  ' "$ROOT/test/fixtures/review-report.md" "$ROOT/test/fixtures/review-quiz.json" \
    "$report" "$quiz" "$SID" "$revision" "$HEAD_SHA" "$snapshot" "$altitude"
}

write_grade() {
  local event="$1" verdict="$2" feedback="$3" out="$4"
  node -e '
    const fs = require("fs");
    const event = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[4], `${JSON.stringify({
      version: 1,
      session: event.session,
      revision: event.revision,
      headRevision: event.headRevision,
      headSha: event.headSha,
      question: event.question,
      attempt: event.attempt,
      verdict: process.argv[2],
      feedback: process.argv[3],
      knowledgeBaseHash: event.knowledge.baseHash,
    }, null, 2)}\n`);
  ' "$event" "$verdict" "$feedback" "$out"
}

write_thread_operation() {
  local kind="$1" thread="$2" report_revision="$3" body="$4" out="$5"
  node -e '
    const fs = require("fs");
    const [kind, thread, reportRevisionRaw, body, out, session, head] = process.argv.slice(1);
    const source = { reportRevision: Number(reportRevisionRaw), headRevision: 1, headSha: head };
    const payload = kind === "question"
      ? { version: 1, session, thread, source, body }
      : kind === "comment"
        ? { version: 1, session, thread, source, body, responseReportRevision: 2, saved: { scope: "project", updated: true } }
        : { version: 1, session, thread, source, status: kind, message: body };
    fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  ' "$kind" "$thread" "$report_revision" "$body" "$out" "$SID" "$HEAD_SHA"
}

echo "# building"
(cd "$ROOT" && bun run build > /dev/null)

REAL_GIT="$(command -v git)"
"$REAL_GIT" -C "$REPO" init -q -b main
"$REAL_GIT" -C "$REPO" remote add origin https://github.com/acme/app.git
FAKE_REPO="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$REPO")"
export FAKE_REPO HEAD_SHA MAIN_SHA WORKTREES
export FAKE_GIT_LOG="$TMP/git.log"

PORT="$(free_port)"
export OTACON_PORT="$PORT"
BASE="http://127.0.0.1:$PORT"
OTACON_PORT="$PORT" OTACON_HOME="$OTACON_HOME" node "$ROOT/dist/daemon/main.js" > "$TMP/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 50); do
  curl -sf --max-time 1 "$BASE/api/health" > /dev/null 2>&1 && break
  sleep 0.1
done
curl -sf "$BASE/api/health" > /dev/null || { tail -40 "$TMP/daemon.log" >&2; fail "daemon did not become healthy"; }

cat > "$FAKE_BIN/gh" <<'SH'
#!/bin/sh
if [ "$1 $2" = "pr view" ]; then
  printf '%s\n' '{"author":{"login":"octo"},"baseRefName":"main","headRefName":"feature/review","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","headRepository":{"nameWithOwner":"acme/app"},"headRepositoryOwner":{"login":"acme"},"isCrossRepository":false,"maintainerCanModify":true,"number":42,"state":"OPEN","title":"Explain the frozen review boundary","url":"https://github.com/acme/app/pull/42"}'
elif [ "$1 $2" = "repo view" ]; then
  printf '%s\n' '{"viewerPermission":"WRITE"}'
else
  printf 'unexpected fake gh call: %s\n' "$*" >&2
  exit 97
fi
SH
cat > "$FAKE_BIN/git" <<'SH'
#!/bin/sh
printf '%s\n' "$PWD :: $*" >> "$FAKE_GIT_LOG"
case "$1 $2" in
  "rev-parse --show-toplevel") printf '%s\n' "$FAKE_REPO" ;;
  "branch --show-current") printf '%s\n' main ;;
  "remote get-url") printf '%s\n' https://github.com/acme/app.git ;;
  "check-ref-format --branch") printf '%s\n' "$3" ;;
  "worktree list")
    printf 'worktree %s\0HEAD %s\0branch refs/heads/main\0\0' "$FAKE_REPO" "$MAIN_SHA"
    ;;
  "rev-parse --verify")
    case "$3" in
      refs/heads/*) exit 1 ;;
      refs/remotes/origin/*) printf '%s\n' "$HEAD_SHA" ;;
      'HEAD^{commit}') printf '%s\n' "$HEAD_SHA" ;;
      *) printf 'unexpected rev-parse target: %s\n' "$3" >&2; exit 96 ;;
    esac
    ;;
  "ls-remote --exit-code") printf '%s\t%s\n' "$HEAD_SHA" "$4" ;;
  "fetch --no-tags") : ;;
  "worktree add") mkdir -p "$6" ;;
  "symbolic-ref --quiet") printf '%s\n' feature/review ;;
  "status --porcelain=v1") : ;;
  *) printf 'unexpected fake git call: %s\n' "$*" >&2; exit 95 ;;
esac
SH
chmod +x "$FAKE_BIN/gh" "$FAKE_BIN/git"
export PATH="$FAKE_BIN:$PATH"

otacon() { node "$ROOT/dist/cli/main.js" "$@"; }
cd "$REPO"

# --- start, unchanged reuse, and immutable r1 submit -----------------------
otacon review start --pr 42 > "$TMP/start.json" 2> "$TMP/start.err"
one_json_line "$TMP/start.json" "review start"
SID="$(json_field session "$TMP/start.json")"
[[ "$SID" == otc_* ]] || fail "review start returned no session"
[ "$(json_field action "$TMP/start.json")" = "created" ] || fail "first review start did not create"
SNAPSHOT1="$(json_field knowledge.snapshot.hash "$TMP/start.json")"
render_review_inputs 1 "$SNAPSHOT1" balanced "$TMP/report-r1.md" "$TMP/quiz-r1.json"
otacon review submit --report "$TMP/report-r1.md" --quiz "$TMP/quiz-r1.json" > "$TMP/submit-r1.json"
one_json_line "$TMP/submit-r1.json" "review submit"
[ "$(json_field revision "$TMP/submit-r1.json")" = "1" ] || fail "review submit did not publish r1"
otacon review start --pr https://github.com/acme/app/pull/42 > "$TMP/reuse.json"
[ "$(json_field session "$TMP/reuse.json")" = "$SID" ] || fail "unchanged PR did not reuse the session"
[ "$(json_field action "$TMP/reuse.json")" = "reused" ] || fail "unchanged PR did not report reused"
ok "review start created once, unchanged start reused, and r1 submitted through the built Node CLI"

# --- choice is local; open answer retries then passes through agent grade ---
curl -sf -X POST "$BASE/api/reviews/$SID/quiz/q-choice/answer" -H 'content-type: application/json' \
  -d '{"revision":1,"answer":"Mutable profile","idempotencyKey":"choice-wrong"}' > "$TMP/choice-retry.json"
[ "$(json_field attempt.status "$TMP/choice-retry.json")" = "retry" ] || fail "wrong choice was not marked retry"
curl -sf -X POST "$BASE/api/reviews/$SID/quiz/q-choice/answer" -H 'content-type: application/json' \
  -d '{"revision":1,"answer":"Frozen snapshot","idempotencyKey":"choice-pass"}' > "$TMP/choice-pass.json"
[ "$(json_field attempt.status "$TMP/choice-pass.json")" = "pass" ] || fail "correct choice was not marked pass"

curl -sf -X POST "$BASE/api/reviews/$SID/quiz/q-open/answer" -H 'content-type: application/json' \
  -d '{"revision":1,"answer":"It keeps a copy.","idempotencyKey":"open-r1-retry"}' > /dev/null
otacon wait --session "$SID" --timeout 10 > "$TMP/open-r1-event-1.json"
[ "$(json_field event "$TMP/open-r1-event-1.json")" = "quiz-answer" ] || fail "open answer did not wake the agent"
write_grade "$TMP/open-r1-event-1.json" retry "Name both the immutable report and the later learning update." "$TMP/grade-r1-retry.json"
otacon review grade q-open --file "$TMP/grade-r1-retry.json" > "$TMP/grade-r1-retry.out"
[ "$(json_field attempt.status "$TMP/grade-r1-retry.out")" = "retry" ] || fail "open answer retry did not persist"

curl -sf -X POST "$BASE/api/reviews/$SID/quiz/q-open/answer" -H 'content-type: application/json' \
  -d '{"revision":1,"answer":"The report pins immutable knowledge while a passed quiz updates only future snapshots.","idempotencyKey":"open-r1-pass"}' > /dev/null
otacon wait --session "$SID" --timeout 10 > "$TMP/open-r1-event-2.json"
write_grade "$TMP/open-r1-event-2.json" pass "Correct: current learning never rewrites the report that produced it." "$TMP/grade-r1-pass.json"
otacon review grade q-open --file "$TMP/grade-r1-pass.json" > "$TMP/grade-r1-pass.out"
[ "$(json_field attempt.status "$TMP/grade-r1-pass.out")" = "pass" ] || fail "open answer pass did not persist"
ok "choice grading stayed local while open grading exercised retry, second answer, pass, and knowledge evidence"

# --- Ask answers only ------------------------------------------------------
node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({intent:"question",anchor:{section:"background",exact:"## Background"},body:"Which side owns the immutable bytes?",reportRevision:1,headRevision:1,headSha:process.argv[2],idempotencyKey:"ask-owner"}));
' "$TMP/ask.json" "$HEAD_SHA"
curl -sf -X POST "$BASE/api/reviews/$SID/threads" -H 'content-type: application/json' --data-binary "@$TMP/ask.json" > "$TMP/ask-created.json"
[ "$(json_field thread.intent "$TMP/ask-created.json")" = "question" ] || fail "Ask did not persist"
otacon wait --session "$SID" --timeout 10 > "$TMP/ask-event.json"
[ "$(json_field work "$TMP/ask-event.json")" = "question" ] || fail "Ask did not deliver question work"
write_thread_operation question q1 1 "The daemon owns the immutable revision directory; the UI receives a sanitized projection." "$TMP/respond-q1.json"
otacon review respond q1 --file "$TMP/respond-q1.json" > "$TMP/respond-q1.out"
[ "$(json_field thread.response.body "$TMP/respond-q1.out")" != "" ] || fail "Ask response did not persist"
curl -sf "$BASE/api/sessions/$SID" > "$TMP/after-ask.json"
[ "$(json_field review.revision "$TMP/after-ask.json")" = "1" ] \
  || fail "Ask answer mutated the report revision"
ok "anchored Ask woke the agent and returned an answer without report mutation"

# --- Comment remember → r2 response → explicit code action -----------------
node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({intent:"comment",anchor:{section:"intuition",exact:"## Intuition"},body:"Make the ownership boundary explicit, then let me conduct the code change.",reportRevision:1,headRevision:1,headSha:process.argv[2],idempotencyKey:"comment-owner",rememberScope:"project"}));
' "$TMP/comment.json" "$HEAD_SHA"
curl -sf -X POST "$BASE/api/reviews/$SID/threads" -H 'content-type: application/json' --data-binary "@$TMP/comment.json" > "$TMP/comment-created.json"
[ "$(json_field thread.intent "$TMP/comment-created.json")" = "comment" ] || fail "Comment did not persist"
otacon wait --session "$SID" --timeout 10 > "$TMP/comment-event.json"
[ "$(json_field work "$TMP/comment-event.json")" = "report-feedback" ] || fail "Comment did not first request report feedback"

otacon knowledge get --scope project --repo "$REPO" > "$TMP/knowledge-before.json"
BASE_HASH="$(json_field document.hash "$TMP/knowledge-before.json")"
node -e '
  const fs=require("fs");
  const input=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const markdown=input.document.markdown.replace("- No preferences recorded yet.", "- Name the daemon as the owner of immutable review revision bytes.");
  fs.writeFileSync(process.argv[2], markdown);
' "$TMP/knowledge-before.json" "$TMP/knowledge.md"
otacon knowledge put --scope project --repo "$REPO" --file "$TMP/knowledge.md" --base-hash "$BASE_HASH" > "$TMP/knowledge-put.json"
[ "$(json_field ok "$TMP/knowledge-put.json")" = "true" ] || fail "remember update did not CAS project knowledge"

otacon review revise --session "$SID" > "$TMP/revise.json"
[ "$(json_field revision "$TMP/revise.json")" = "2" ] || fail "Comment did not prepare r2"
SNAPSHOT2="$(json_field knowledge.snapshot.hash "$TMP/revise.json")"
[ "$SNAPSHOT2" != "$SNAPSHOT1" ] || fail "remembered knowledge was not frozen into r2"
render_review_inputs 2 "$SNAPSHOT2" expert "$TMP/report-r2.md" "$TMP/quiz-r2.json"
otacon review submit --report "$TMP/report-r2.md" --quiz "$TMP/quiz-r2.json" > "$TMP/submit-r2.json"
[ "$(json_field revision "$TMP/submit-r2.json")" = "2" ] || fail "replacement report did not publish"
write_thread_operation comment t1 1 "Revision 2 names daemon ownership and preserves the causal read." "$TMP/respond-t1.json"
otacon review respond t1 --file "$TMP/respond-t1.json" > "$TMP/respond-t1.out"
[ "$(json_field thread.saved.scope "$TMP/respond-t1.out")" = "project" ] || fail "Comment response did not acknowledge requested project memory"

node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({source:{reportRevision:1,headRevision:1,headSha:process.argv[2]}}));
' "$TMP/code-request.json" "$HEAD_SHA"
curl -sf -X POST "$BASE/api/reviews/$SID/threads/t1/code-action" -H 'content-type: application/json' --data-binary "@$TMP/code-request.json" > "$TMP/code-request.out"
[ "$(json_field thread.codeAction.status "$TMP/code-request.out")" = "requested" ] || fail "Comment code action was not requested"
otacon wait --session "$SID" --timeout 10 > "$TMP/code-event.json"
[ "$(json_field work "$TMP/code-event.json")" = "code-change" ] || fail "explicit second step did not deliver code-change work"

otacon review checkout --session "$SID" > "$TMP/checkout.json"
[ "$(json_field action "$TMP/checkout.json")" = "created" ] || fail "fake safe worktree was not created"
[ "$(json_field push.remote "$TMP/checkout.json")" = "origin" ] || fail "checkout did not return a push destination"
write_thread_operation working t1 1 "Subagent is implementing inside the exact review worktree." "$TMP/code-working.json"
otacon review code-status t1 --file "$TMP/code-working.json" > "$TMP/code-working.out"
[ "$(json_field thread.codeAction.status "$TMP/code-working.out")" = "working" ] \
  || fail "code action did not reach working"
write_thread_operation completed t1 1 "Reviewed and verified without touching a real remote." "$TMP/code-complete.json"
otacon review code-status t1 --file "$TMP/code-complete.json" > "$TMP/code-complete.out"
[ "$(json_field thread.codeAction.status "$TMP/code-complete.out")" = "completed" ] || fail "code action did not reach completed"
grep -q 'fetch --no-tags' "$FAKE_GIT_LOG" || fail "checkout did not exercise the fake fetch seam"
grep -q 'worktree add' "$FAKE_GIT_LOG" || fail "checkout did not exercise the fake worktree seam"
if grep -Eq '(^| )((reset)|(checkout)|(commit)|(push))($| )' "$FAKE_GIT_LOG"; then
  fail "checkout invoked a destructive or publishing git verb"
fi
ok "Comment revised the report, acknowledged memory, then separately authorized a safe fake worktree code action"

# --- pass r2 quiz, clean Done, terminal wake, and completed reuse ------------
curl -sf -X POST "$BASE/api/reviews/$SID/quiz/q-choice/answer" -H 'content-type: application/json' \
  -d '{"revision":2,"answer":"Frozen snapshot","idempotencyKey":"choice-r2-pass"}' > /dev/null
curl -sf -X POST "$BASE/api/reviews/$SID/quiz/q-open/answer" -H 'content-type: application/json' \
  -d '{"revision":2,"answer":"A report pins one immutable snapshot; quiz evidence changes only later authoring inputs.","idempotencyKey":"open-r2-pass"}' > /dev/null
otacon wait --session "$SID" --timeout 10 > "$TMP/open-r2-event.json"
write_grade "$TMP/open-r2-event.json" pass "The immutable/current boundary and causal direction are both explicit." "$TMP/grade-r2-pass.json"
otacon review grade q-open --file "$TMP/grade-r2-pass.json" > /dev/null

curl -sf -X POST "$BASE/api/reviews/$SID/done" -H 'content-type: application/json' -d '{}' > "$TMP/done.json"
[ "$(json_field completion.forced "$TMP/done.json")" = "false" ] || fail "clean Done unexpectedly forced completion"
[ "$(json_field completion.unresolved.conversations "$TMP/done.json")" = "0" ] || fail "clean Done retained conversation work"
[ "$(json_field completion.unresolved.quizzes "$TMP/done.json")" = "0" ] || fail "clean Done retained quiz work"
otacon wait --session "$SID" --timeout 10 > "$TMP/done-event.json"
[ "$(json_field event "$TMP/done-event.json")" = "review-done" ] || fail "Done did not wake the long-lived review agent"
otacon review start --pr 42 > "$TMP/reuse-complete.json"
[ "$(json_field action "$TMP/reuse-complete.json")" = "reused-complete" ] || fail "completed review did not reopen read-only"
[ "$(json_field readOnly "$TMP/reuse-complete.json")" = "true" ] || fail "completed reuse was not read-only"
ok "r2 quiz passed, clean Done emitted one terminal wake, and unchanged completed review reused read-only"

echo "# e2e-review: all $PASS checks passed"
