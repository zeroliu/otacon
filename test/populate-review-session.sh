#!/usr/bin/env bash
# Seed the production PR-review UI with two realistic local-only sessions:
# a balanced report that still has a retry + Comment, and an expert report
# ready for clean Done. No GitHub command or remote mutation is performed.
set -euo pipefail

PROFILE="${1:-balanced}"
case "$PROFILE" in
  balanced|expert) ;;
  *) echo "error: expected balanced or expert, got '$PROFILE'" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -x "$ROOT/bin/otacon" ] || { echo "error: missing $ROOT/bin/otacon" >&2; exit 1; }
OTACON="$ROOT/bin/otacon"
FIXTURES="$ROOT/test/fixtures"
REPO="${TMPDIR:-/tmp}/otacon-review-demo-repo"
mkdir -p "$REPO"
if [ ! -d "$REPO/.git" ]; then
  git -C "$REPO" init -q -b main
  git -C "$REPO" remote add origin https://github.com/zeroliu/otacon.git
fi

jf() { node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))'"$1"; }

STATUS="$(cd "$REPO" && "$OTACON" status 2>/dev/null)"
PORT="$(printf '%s' "$STATUS" | jf .daemon.port)"
BASE="http://127.0.0.1:$PORT"
HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"

# Re-runs replace only this script's two canonical PRs in its dedicated scratch
# repository. The daemon derives titles from PR metadata, so repo path + PR
# identity is the stable ownership marker.
for sid in $(curl -s "$BASE/api/sessions" | node -e '
  const fs = require("fs");
  const sessions = JSON.parse(fs.readFileSync(0,"utf8")).sessions;
  const repo = fs.realpathSync(process.argv[1]);
  const realpath = (path) => { try { return fs.realpathSync(path); } catch { return null; } };
  process.stdout.write(sessions
    .filter((session) => session.kind === "review" &&
      realpath(session.repo) === repo &&
      [72, 91].includes(session.review.pullRequest.identity.number))
    .map((session) => session.id).join("\n"));
' "$REPO"); do
  curl -s -X DELETE "$BASE/api/sessions/$sid" > /dev/null
done

put_project_knowledge() {
  local sentence="$1"
  (cd "$REPO" && "$OTACON" knowledge get --scope project --repo "$REPO") > "$REPO/knowledge-current.json"
  local base_hash
  base_hash="$(jf .document.hash < "$REPO/knowledge-current.json")"
  node -e '
    const fs = require("fs");
    const document = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).document;
    const sections = document.markdown
      .replace(/## Preferences\n\n[\s\S]*?\n\n## Demonstrated concepts/, `## Preferences\n\n- ${process.argv[3]}\n\n## Demonstrated concepts`);
    fs.writeFileSync(process.argv[2], sections);
  ' "$REPO/knowledge-current.json" "$REPO/knowledge-next.md" "$sentence"
  (cd "$REPO" && "$OTACON" knowledge put --scope project --repo "$REPO" \
    --file "$REPO/knowledge-next.md" --base-hash "$base_hash") > /dev/null
}

create_review() {
  local number="$1" title="$2" author="$3" ref="$4" out="$5"
  node -e '
    const fs = require("fs");
    const [out, repo, numberRaw, title, author, ref, head] = process.argv.slice(1);
    const number = Number(numberRaw);
    fs.writeFileSync(out, JSON.stringify({
      repo,
      repository: "zeroliu/otacon",
      branch: "main",
      force: true,
      pullRequest: {
        identity: { host: "github.com", repository: "zeroliu/otacon", number, key: `github.com/zeroliu/otacon#${number}` },
        url: `https://github.com/zeroliu/otacon/pull/${number}`,
        title,
        author,
        baseRef: "main",
        headRef: ref,
        headRepository: "zeroliu/otacon",
        headSha: head,
        state: "open",
        isCrossRepository: false,
        permissions: { maintainerCanModify: true, viewerPermission: "write", readOnly: false },
      },
    }));
  ' "$out" "$REPO" "$number" "$title" "$author" "$ref" "$HEAD_SHA"
  curl -sf -X POST "$BASE/api/reviews" -H 'content-type: application/json' --data-binary "@$out"
}

render_inputs() {
  local start="$1" number="$2" altitude="$3" report="$4" quiz="$5"
  node -e '
    const fs = require("fs");
    const [startPath, numberRaw, altitude, reportFixture, quizFixture, reportOut, quizOut] = process.argv.slice(1);
    const start = JSON.parse(fs.readFileSync(startPath, "utf8"));
    const session = start.session.id;
    const head = start.session.review.head.sha;
    const snapshot = start.preparation.snapshot.hash;
    const number = Number(numberRaw);
    const report = fs.readFileSync(reportFixture, "utf8")
      .replace(/^session: .*$/m, `session: ${session}`)
      .replace(/^pr: .*$/m, `pr: github.com/zeroliu/otacon#${number}`)
      .replace(/^head: .*$/m, `head: ${head}`)
      .replace(/^knowledge-snapshot: .*$/m, `knowledge-snapshot: ${snapshot}`)
      .replace(/^altitude: .*$/m, `altitude: ${altitude}`);
    const quiz = JSON.parse(fs.readFileSync(quizFixture, "utf8"));
    Object.assign(quiz, { session, revision: 1, headRevision: 1, headSha: head });
    fs.writeFileSync(reportOut, report);
    fs.writeFileSync(quizOut, `${JSON.stringify(quiz, null, 2)}\n`);
  ' "$start" "$number" "$altitude" "$FIXTURES/review-report.md" "$FIXTURES/review-quiz.json" "$report" "$quiz"
}

grade_event() {
  local event="$1" verdict="$2" feedback="$3" out="$4"
  node -e '
    const fs = require("fs");
    const event = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[4], JSON.stringify({
      version: 1, session: event.session, revision: event.revision,
      headRevision: event.headRevision, headSha: event.headSha,
      question: event.question, attempt: event.attempt,
      verdict: process.argv[2], feedback: process.argv[3],
      knowledgeBaseHash: event.knowledge.baseHash,
    }));
  ' "$event" "$verdict" "$feedback" "$out"
  (cd "$REPO" && "$OTACON" review grade q-open --file "$out") > /dev/null
}

put_project_knowledge "Expand unfamiliar storage ownership; keep established UI details concise."

# Balanced: visible retry, one answered+remembered Ask, one open Comment.
create_review 91 "Preserve a frozen knowledge snapshot per review revision" "alexchen" \
  "feat/review-knowledge-snapshot" "$REPO/balanced-start-body.json" > "$REPO/balanced-start.json"
BALANCED_SID="$(jf .session.id < "$REPO/balanced-start.json")"
render_inputs "$REPO/balanced-start.json" 91 balanced "$REPO/balanced-report.md" "$REPO/balanced-quiz.json"
(cd "$REPO" && "$OTACON" review submit --report "$REPO/balanced-report.md" --quiz "$REPO/balanced-quiz.json") > /dev/null
curl -sf -X POST "$BASE/api/reviews/$BALANCED_SID/quiz/q-choice/answer" -H 'content-type: application/json' \
  -d '{"revision":1,"answer":"Frozen snapshot","idempotencyKey":"demo-balanced-choice"}' > /dev/null
curl -sf -X POST "$BASE/api/reviews/$BALANCED_SID/quiz/q-open/answer" -H 'content-type: application/json' \
  -d '{"revision":1,"answer":"It saves some context.","idempotencyKey":"demo-balanced-open"}' > /dev/null
(cd "$REPO" && "$OTACON" wait --session "$BALANCED_SID" --timeout 10) > "$REPO/balanced-quiz-event.json"
grade_event "$REPO/balanced-quiz-event.json" retry \
  "Name both the immutable report revision and why later learning must not rewrite it." "$REPO/balanced-grade.json"

node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({intent:"question",anchor:{section:"background",exact:"mutable profile knowledge"},body:"Where are the frozen Markdown bytes stored?",reportRevision:1,headRevision:1,headSha:process.argv[2],idempotencyKey:"demo-balanced-ask",rememberScope:"project"}));
' "$REPO/balanced-ask.json" "$HEAD_SHA"
curl -sf -X POST "$BASE/api/reviews/$BALANCED_SID/threads" -H 'content-type: application/json' \
  --data-binary "@$REPO/balanced-ask.json" > /dev/null
(cd "$REPO" && "$OTACON" wait --session "$BALANCED_SID" --timeout 10) > /dev/null
put_project_knowledge "The daemon owns immutable report revision bytes; expand storage boundaries when new."
node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({version:1,session:process.argv[2],thread:"q1",source:{reportRevision:1,headRevision:1,headSha:process.argv[3]},body:"The daemon stores each revision under the local session home; the browser receives only the verified public projection.",saved:{scope:"project",updated:true}}));
' "$REPO/balanced-ask-response.json" "$BALANCED_SID" "$HEAD_SHA"
(cd "$REPO" && "$OTACON" review respond q1 --file "$REPO/balanced-ask-response.json") > /dev/null

node -e '
  const fs=require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({intent:"comment",anchor:{section:"code",exact:"publishes one immutable revision directory"},body:"Make this transaction boundary visible in the report before changing code.",reportRevision:1,headRevision:1,headSha:process.argv[2],idempotencyKey:"demo-balanced-comment",rememberScope:"project"}));
' "$REPO/balanced-comment.json" "$HEAD_SHA"
curl -sf -X POST "$BASE/api/reviews/$BALANCED_SID/threads" -H 'content-type: application/json' \
  --data-binary "@$REPO/balanced-comment.json" > /dev/null

# Expert: richer snapshot, both questions passed, no conversations; Done is clean.
put_project_knowledge "Assume architecture fluency; emphasize only changed contracts and causal seams."
create_review 72 "Typed review events without leaking private rubrics" "mira" \
  "feat/typed-review-events" "$REPO/expert-start-body.json" > "$REPO/expert-start.json"
EXPERT_SID="$(jf .session.id < "$REPO/expert-start.json")"
render_inputs "$REPO/expert-start.json" 72 expert "$REPO/expert-report.md" "$REPO/expert-quiz.json"
(cd "$REPO" && "$OTACON" review submit --report "$REPO/expert-report.md" --quiz "$REPO/expert-quiz.json") > /dev/null
curl -sf -X POST "$BASE/api/reviews/$EXPERT_SID/quiz/q-choice/answer" -H 'content-type: application/json' \
  -d '{"revision":1,"answer":"Frozen snapshot","idempotencyKey":"demo-expert-choice"}' > /dev/null
curl -sf -X POST "$BASE/api/reviews/$EXPERT_SID/quiz/q-open/answer" -H 'content-type: application/json' \
  -d '{"revision":1,"answer":"A report pins immutable authoring inputs; later evidence changes only a future snapshot.","idempotencyKey":"demo-expert-open"}' > /dev/null
(cd "$REPO" && "$OTACON" wait --session "$EXPERT_SID" --timeout 10) > "$REPO/expert-quiz-event.json"
grade_event "$REPO/expert-quiz-event.json" pass \
  "Correct: the current report remains reproducible while future authoring learns." "$REPO/expert-grade.json"

SEEDED_COUNT="$(curl -s "$BASE/api/sessions" | node -e '
  const fs = require("fs");
  const sessions = JSON.parse(fs.readFileSync(0,"utf8")).sessions;
  const repo = fs.realpathSync(process.argv[1]);
  const realpath = (path) => { try { return fs.realpathSync(path); } catch { return null; } };
  process.stdout.write(String(sessions.filter((session) => session.kind === "review" &&
    realpath(session.repo) === repo &&
    [72, 91].includes(session.review.pullRequest.identity.number)).length));
' "$REPO")"
[ "$SEEDED_COUNT" = "2" ] || {
  echo "error: review prototype expected exactly two owned sessions, found $SEEDED_COUNT" >&2
  exit 1
}

FOCUS_SID="$BALANCED_SID"
[ "$PROFILE" = expert ] && FOCUS_SID="$EXPERT_SID"
URL="$BASE/s/$FOCUS_SID"

echo
echo "=================================================================="
echo "  balanced : $BALANCED_SID  (retry + remembered Ask + open Comment)"
echo "  expert   : $EXPERT_SID  (all quizzes passed; clean Done)"
echo "  daemon   : $BASE"
echo "  REVIEW   : $URL"
echo "=================================================================="
echo "  Manual checks remaining:"
echo "  - balanced: retry the open quiz; inspect the remembered Ask receipt"
echo "  - balanced: open the Comment, then choose Conduct code change"
echo "  - balanced: Done warns, then Close anyway preserves the report"
echo "  - expert: Done closes immediately with no warning"
echo

if [ "${OTACON_NO_BROWSER:-0}" != "1" ]; then
  (cd "$REPO" && "$OTACON" open --session "$FOCUS_SID") > /dev/null 2>&1 || true
fi
