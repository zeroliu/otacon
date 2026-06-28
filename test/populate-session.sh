#!/usr/bin/env bash
# populate-session.sh — drive the AGENT side of the otacon protocol so a worktree
# is left with a REALISTIC review session running in the browser, then print the
# URL. This is the manual-e2e counterpart to test/e2e-*.sh: same protocol moves,
# but it does NOT tear down — it leaves the daemon up so you can review by hand.
#
# Run it from the checkout you want to exercise — it uses that checkout's own
# ./bin/otacon, which means its ISOLATED per-worktree daemon/port/home (see
# bin/otacon). So three worktrees can each hold their own demo session at once.
#
#   cd .claude/worktrees/<feature>
#   bun run build                                   # daemon serves the real UI
#   bash /Users/zeroliu/Developer/otacon/test/populate-session.sh [flavor]
#
# flavor (default: full):
#   full     r1 + grill Q&A + comment threads + r2 → a diff, a resolved+anchored
#            thread, and an orphaned thread. The all-purpose realistic surface.
#   visuals  r1 is a plan built from inline callout badges + a decision matrix +
#            inline pills + a Given/When/Then scenario card block, with a comment
#            anchored INTO a callout badge line. For expressive-plan-visuals.
#   notify   full base, then an interactive loop: fire a grill question / a new
#            revision on demand so you can test focus/blur banner suppression.
#   activity full base, then streams `otacon progress` notes live so you can watch
#            the activity feed + presence dot update. Needs the `progress` verb.
#
# Teardown: `./bin/otacon clean` (archive the session) or `./bin/otacon restart`
# (drop the daemon). The scratch git repo lives under $TMPDIR and is reused per
# flavor on the next run.
set -euo pipefail

FLAVOR="${1:-full}"

# Absolute path to this checkout's CLI shim, captured before we cd into the demo
# repo. Invoking it by absolute path keeps bin/otacon's per-worktree isolation
# keyed to the worktree (it inspects its own location), while the session binds
# to whatever cwd we run `start` from — here, the scratch repo below.
[ -x "./bin/otacon" ] || { echo "error: no ./bin/otacon here — run from a checkout root" >&2; exit 1; }
OTACON="$(pwd)/bin/otacon"
FIXTURES="$(pwd)/test/fixtures"

# Lead the realistic plan's Risks bullets with [!risk] badges so the populated
# session exercises the inline callout-badge primitive. Rewrites only the
# per-session copy — test/fixtures/valid-plan.md stays pristine for the unit and
# e2e suites that anchor to its exact text.
enrich_risk_badges() {
  sed -e 's|^- Key rotation downtime|[!risk] Key rotation downtime|' \
      -e 's|^- Clock skew between|[!risk] Clock skew between|' \
      "$1" > "$1.badge" && mv "$1.badge" "$1"
}

# Read one field off a JSON object on stdin (the repo's jq-free idiom).
jf() { node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))'"$1"; }

# A fresh scratch git repo (stable path per flavor → idempotent reruns).
REPO="${TMPDIR:-/tmp}/otacon-demo-$FLAVOR"
rm -rf "$REPO"; mkdir -p "$REPO"
git -C "$REPO" init -q -b main
cd "$REPO"

# Reap demo sessions left by prior runs so the home store doesn't accumulate:
# the drafts below never reach a terminal status (so `otacon clean` won't reap
# them) and each run mints fresh ids. The "demo: " title prefix scopes this
# strictly to this script's own sessions — real sessions are never matched, even
# from the main checkout where OTACON_HOME is the real ~/.otacon. `status` first
# ensures the daemon is up before the curl.
PORT="$("$OTACON" status 2>/dev/null | jf .daemon.port)"
BASE="http://127.0.0.1:$PORT"
for sid in $(curl -s "$BASE/api/sessions" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).sessions.filter(s=>s.title.startsWith("demo: ")).map(s=>s.id).join("\n")'); do
  curl -s -X DELETE "$BASE/api/sessions/$sid" >/dev/null
done

echo "# starting session ($FLAVOR) in $REPO"
# `start` returns `plan`: the home-store path the agent must write the draft to
# (~/.otacon/sessions/<id>/plan.md, isolated per worktree). The daemon reads the
# draft from THERE, not from this scratch repo's .otacon/ — so derive SDIR from
# it and write every plan there.
START="$("$OTACON" start --title "demo: $FLAVOR" 2>/dev/null)"
SID="$(printf '%s' "$START" | jf .session)"
[[ "$SID" == otc_* ]] || { echo "error: start did not return a session id" >&2; exit 1; }
SDIR="$(dirname "$(printf '%s' "$START" | jf .plan)")"
URL="$BASE/s/$SID"
mkdir -p "$SDIR"

# ---- r1 ---------------------------------------------------------------------
if [ "$FLAVOR" = visuals ]; then
  # Built inline so it is self-contained and exercises every render primitive:
  # inline callout badges (all four hues), a decision matrix, inline pills, and a
  # Given/When/Then scenario-card block under a phase's Verification. The decision
  # matrix is the one budget-exempt capped visual per section; callout badges and
  # inline pills are inline and always free, and a ```gwt block is fence- and
  # visual-exempt (validated separately by the linter, plan structure, lint, and anchoring).
  cat > "$SDIR/plan.md" <<EOF
---
title: visuals-demo
session: $SID
revision: 1
status: in_review
created: 2026-06-13
---

# visuals-demo

## Summary

Demonstrates the render primitives so each can be reviewed: inline callout
badges, a decision matrix, and inline scope pills.

[!decision] Ship callouts, matrix, and pills together rather than one at a time.

## Decisions

| ✓ | Option | Tradeoff |
| --- | --- | --- |
| ✓ | Markdown-native primitives | Comment-anchorable; degrades to plain markdown |
|  | Fenced mini-DSLs | Cleaner authoring, but anchors only at section level |

## Phases

### Phase 1 — Callouts [new]

Goal: Render \`[!risk]\` \`[!note]\` \`[!decision]\` \`[!assumption]\` markers as inline badges.
Files:
- src/ui/plan/callout.ts
Verification: A 4-type sample renders; an over-cap section fails lint.

[!risk] A selection spanning a pill token may break comment anchoring — verify it.

\`\`\`gwt
Given a phase whose Verification holds a gwt fence
When the reviewer opens the plan
Then each scenario renders as its own numbered card
And the Given/When/Then keywords read as inked labels

Given a scenario missing its Then clause
When the daemon lints the submit
Then it reports E_GWT_MALFORMED and blocks the revision
\`\`\`

### Phase 2 — Matrix and pills [breaking]

Goal: Style tables as decision matrices and inline \`[new] [risky] [deletes]\` tokens as pills.
Files:
- src/ui/plan/markdown.tsx
Verification: A ✓ row highlights the winner; links and \`[assumed]\` stay untouched.

[!assumption] The callout and pill classes survive DOMPurify sanitization.

[!note] All four badge hues read clearly in light and dark.

## Risks

[!risk] Budget exemption could smuggle in prose — the per-section count cap is the guard.

## Open Questions

- Confirm the callout vocabulary and the pill keyword set.
EOF
else
  # The committed known-good fixture (passes the linter as-is), with its Risks
  # bullets promoted to [!risk] badges so the realistic surface shows them too.
  sed "s/otc_test01/$SID/" "$FIXTURES/valid-plan.md" > "$SDIR/plan.md"
  enrich_risk_badges "$SDIR/plan.md"
fi

# ---- grill (ask before drafting, mirroring the real loop) -------------------
# Every verb addresses $SID explicitly. This scratch repo's path accumulates
# draft sessions across reruns — they never reach `approved`, so nothing reaps
# them — and path-based resolution would then refuse with E_AMBIGUOUS_SESSION.
"$OTACON" ask --session "$SID" --question "RS256 or HS256?" --options "RS256|HS256" --recommend RS256 >/dev/null
"$OTACON" ask --session "$SID" --question "Anything that should stay out of scope?" >/dev/null
# Answer q1 over curl (the phone's path); leave q2 pending so a live grill card shows.
curl -s -X POST "$BASE/api/sessions/$SID/answers" -H 'content-type: application/json' \
  -d '{"question":"q1","choice":"RS256","text":"simpler key-rotation story"}' >/dev/null
echo "# grill: q1 answered, q2 left pending"

# ---- submit r1 --------------------------------------------------------------
"$OTACON" submit --session "$SID" >/dev/null
echo "# revision 1 submitted"

if [ "$FLAVOR" = visuals ]; then
  # One comment anchored INTO a callout body — sets up the anchoring test (R1/P3).
  curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' -d '{
    "items": [{"anchor": {"section": "phase-1", "exact": "may break comment anchoring"},
               "body": "does selecting inside a callout still anchor here?"}]}' >/dev/null
  echo "# comment anchored inside a callout"
else
  # Two threads: t1 (decisions) survives r2; t2 (phase-1 quote) gets deleted → orphan.
  curl -s -X POST "$BASE/api/sessions/$SID/comments" -H 'content-type: application/json' -d '{
    "items": [
      {"anchor": {"section": "decisions", "exact": "Sessions table stays until phase 3"}, "body": "still true after r2?"},
      {"anchor": {"section": "phase-1", "exact": "key rotation"}, "body": "what cadence?"}
    ]}' >/dev/null
  echo "# comment batch flushed (t1 + t2); r1 marked last-reviewed"

  # ---- r2: edit the plan, delete t2's quote, submit with resolutions --------
  sed -e 's/key rotation\.$/scheduled re-issue./' \
      -e 's/Unit tests cover issuance and/Unit tests cover issuance, expiry, and/' \
      "$SDIR/plan.md" > "$SDIR/plan.next" && mv "$SDIR/plan.next" "$SDIR/plan.md"
  cat > "$REPO/res.json" <<'JSON'
{
  "changelog": "Replaced key rotation with scheduled re-issue; verification now covers expiry.",
  "threads": {
    "t1": "Yes — the sessions table backs rollback until phase 3.",
    "t2": "Dropped rotation in favor of scheduled re-issue; see Phase 1."
  }
}
JSON
  "$OTACON" submit --session "$SID" --resolutions "$REPO/res.json" >/dev/null
  echo "# revision 2 submitted: diff vs r1, t1 resolved+anchored, t2 orphaned"
fi

# ---- a second, APPROVED session ---------------------------------------------
# So the hide-approved work is demoable: it is gone from the switcher (session registry and switcher) and
# grouped under home's collapsed `approved` section (review UI). The redirect (approval and archive lifecycle) is
# a manual approve of the MAIN (active) session in the UI. Force-approve here is
# what the UI does after its unresolved-thread warning; this is a plain Save, so
# the project copy lands in the scratch repo's .otacon/plans/ (untracked, otacon
# never commits it) and a canonical copy in the home archive (~/.otacon/sessions/).
APPROVED_START="$("$OTACON" start --title "demo: $FLAVOR (approved)" 2>/dev/null)"
APPROVED_SID="$(printf '%s' "$APPROVED_START" | jf .session)"
if [[ "$APPROVED_SID" == otc_* ]]; then
  APPROVED_SDIR="$(dirname "$(printf '%s' "$APPROVED_START" | jf .plan)")"
  mkdir -p "$APPROVED_SDIR"
  sed "s/otc_test01/$APPROVED_SID/" "$FIXTURES/valid-plan.md" > "$APPROVED_SDIR/plan.md"
  enrich_risk_badges "$APPROVED_SDIR/plan.md"
  "$OTACON" submit --session "$APPROVED_SID" >/dev/null
  curl -s -X POST "$BASE/api/sessions/$APPROVED_SID/approve" \
    -H 'content-type: application/json' -d '{"force":true}' >/dev/null
  echo "# second session $APPROVED_SID approved: hidden from the switcher, grouped on home"
fi

echo
echo "=================================================================="
echo "  session : $SID"
echo "  daemon  : $BASE   (this checkout's isolated daemon)"
echo "  REVIEW  : $URL"
echo "=================================================================="
echo "  open it:  $OTACON open --session $SID    (or paste the URL)"
echo "  phone  :  $OTACON expose       (Tailscale HTTPS)"
echo "  reset  :  $OTACON restart  |  archive: $OTACON clean"
echo

# Open it — manual e2e wants eyes on the page (no-op if the browser can't open).
"$OTACON" open --session "$SID" >/dev/null 2>&1 || true

# ---- flavor-specific live drivers -------------------------------------------
case "$FLAVOR" in
  notify)
    echo "notify: arrange your review tab (focused vs background/closed) BETWEEN fires."
    echo "  focused tab → suppressed; background/minimized/closed → banner fires."
    while true; do
      printf 'fire what? [q]uestion / [r]evision / [Q]uit: '
      read -r key || break
      case "$key" in
        q|"") "$OTACON" ask --session "$SID" --question "Follow-up at $(date +%H:%M:%S) — proceed?" --options "yes|no" >/dev/null \
                && echo "  -> grill question posted (watch for a banner)";;
        r)    printf '\n<!-- nudge %s -->\n' "$(date +%s)" >> "$SDIR/plan.md"
              "$OTACON" submit --session "$SID" --resolutions "$REPO/res.json" >/dev/null 2>&1 \
                && echo "  -> revision submitted (watch for a banner)" \
                || echo "  -> submit refused (likely needs fresh resolutions); try a question instead";;
        Q)    break;;
      esac
    done
    ;;
  activity)
    echo "activity: streaming progress notes — watch the feed + presence dot update live."
    if ! "$OTACON" progress --session "$SID" "warming up" >/dev/null 2>&1; then
      echo "  (the 'progress' verb isn't built in this checkout yet — skipping the stream)"
    else
      for note in "reading the auth module" "mapping the session store" \
                  "drafting the plan" "revising for the comment batch" "ready for your review"; do
        "$OTACON" progress --session "$SID" "$note" >/dev/null 2>&1 && echo "  -> $note"
        sleep 4
      done
      echo "  done — the dot should drift to 'offline' once the live threshold passes."
    fi
    ;;
esac
