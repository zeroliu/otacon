<img width="9034" height="1857" alt="github-otacon" src="https://github.com/user-attachments/assets/18796111-63d7-4df6-a2ba-b95f132eabd3" />

**Revolutionize agentic coding review — give your agent's plans the design-doc review they deserve.**

Concise, reviewable plans · anchored inline comments · review from your phone · zero API spend.

[![npm version](https://img.shields.io/npm/v/otacon.svg)](https://www.npmjs.com/package/otacon)
[![node](https://img.shields.io/node/v/otacon.svg)](https://www.npmjs.com/package/otacon)
[![license](https://img.shields.io/npm/l/otacon.svg)](LICENSE)

otacon is the plan-review surface for coding agents — Claude Code, Codex, OpenCode. It
replaces native plan mode with one CLI protocol: your agent interviews you, drafts a
concise schema'd plan, and hands you a real review surface where you comment, ask, diff,
and sign off before a single line gets written. It's mission support over codec — Snake's
in the field, otacon's on the line.

## Get started

### Install

```sh
npm install -g otacon   # one package: CLI + daemon (Node ≥ 20)
otacon install --all    # register every agent — Claude Code / Codex / OpenCode
otacon doctor           # verify: node, daemon boots, wrappers, Tailscale
```

Agent flags, the Claude Code Stop hook, building from source → [docs/INSTALL.md](docs/INSTALL.md).

No per-repo setup — the first `otacon start` creates `.otacon/` (and gitignores it), and
approved plans land committed in `docs/plans/`.

### Use it in your repo

1. **Ask your coding agent to plan something.** It runs `otacon start` and prints a
   review URL — open it. (You can review from your phone, too — see below.)
2. **It grills you.** A short interview, one question at a time — answer with chips or
   free text right in the browser.
3. **It drafts a concise, schema'd plan.** You review: select any text to leave an inline
   comment, fire a quick question without touching the plan, and diff revisions to see
   only what changed since you last looked.
4. **Approve** and the plan is committed to `docs/plans/`. Or **Approve & Implement** and
   the same agent builds it phase-by-phase and opens a PR.

## Why otacon

Native plan mode hands you a wall of terminal text and asks you to bless it. So you
rubber-stamp it. Your feedback is unanchored — no line to point at, no diff — so
re-reviewing the next revision costs as much as the first read. Plans are text-only, with
nowhere to put a diagram or a decision table. And one long session degrades: by the time
the agent is deep in the build, it has half-forgotten the plan it pitched you.

Serious engineering orgs don't ship from a wall of terminal text. They review a **design
doc**: inline comments, a real review pass, sign-off before anyone builds. otacon brings
that discipline to coding agents.

### Plans you actually read

A wall of prose is easy to skim and impossible to vet. otacon plans are schema'd and
concise — a lead diagram up top, then visuals where they carry weight: callouts for the
sharp edges, decision matrices for the tradeoffs, and Given/When/Then behavioral
assertions that double as your approve checklist (Test-Driven Review). A deterministic
linter runs on every submit, so each plan stays tight and honest before it ever reaches
you.

### Comment, don't rubber-stamp

Approval should mean something. Select any passage and leave an inline comment anchored to
that exact text — comments batch into ONE clean revision with a changelog, instead of a
scattered back-and-forth. Need a clarification, not a change? **Quick Ask** gets you an
instant answer without touching the plan. And on every revision, the **diff shows only
what changed since you last reviewed** — so re-review is cheap, and the agent must reply
to resolve every comment thread.

### It interviews you first

Plans that skip the hard questions look great and fall apart on contact. So otacon runs a
mandatory grill before any plan reaches review: one question at a time, recommended answer
first, all answerable from your phone. Every decision in the finished plan traces back to
the answer that produced it (enforced) — and the interview ships with the approved plan,
so the *why* is never lost.

### Review from your phone

The 5 minutes before you hit the road shouldn't block your agent. Reviews run over
Tailscale — one thumb, anywhere — and because it's your own tailnet, your plans never
leave your own devices. Setup → [docs/PHONE-ACCESS.md](docs/PHONE-ACCESS.md).

### From approved plan to shipped PR

Approval shouldn't be where the rigor ends. **Approve & Implement** carries the plan
straight into the build: the same agent walks the phases with a fresh subagent per phase
(implement and test, then an independent review pass), then opens a PR.

### Private & free by construction

The daemon, CLI, and UI never call an LLM — all the intelligence runs in your existing
subscription-backed agent session, so otacon adds zero API spend. It's local-first: your
plans stay on your machines.

---

For contributors: [DESIGN.md](DESIGN.md) (behavior spec) · [DECISIONS.md](DECISIONS.md)
(rationale) · [AGENTS.md](AGENTS.md) (conventions). Maintainers cutting a release: see
[RELEASING.md](RELEASING.md). These are internal docs — the user-facing guides live in
`docs/`.
