<p align="center">
  <img src="https://github.com/user-attachments/assets/18796111-63d7-4df6-a2ba-b95f132eabd3" alt="otacon" width="720">
</p>

<h3 align="center">Stop rubber-stamping your agent's plans</h3>

<p align="center">
  <a href="https://www.npmjs.com/package/otacon"><img src="https://img.shields.io/npm/v/otacon.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/otacon"><img src="https://img.shields.io/node/v/otacon.svg" alt="node"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/otacon.svg" alt="license"></a>
</p>

<p align="center">
  <a href="#installation"><b>Installation</b></a>&nbsp; ·&nbsp;
  <a href="#get-started"><b>Get started</b></a>&nbsp; ·&nbsp;
  <a href="#why-otacon"><b>Why Otacon</b></a>&nbsp; ·&nbsp;
  <a href="docs/PHONE-ACCESS.md"><b>Phone access</b></a>
</p>

<br/>

Otacon replaces your coding agent's native plan mode with a review surface you'll actually use. Your agent (Claude Code, Codex, or OpenCode) interviews you until it understands the goal, drafts a concise plan with the discipline of an engineering design doc, and hands you a real place to comment, ask, and diff revisions, then sign off before a line of code is written.

## Installation

```sh
npm install -g otacon
```

## Get started

**Install the skill into your agent.** This drops the Otacon skill into the agent's skill
folder so it knows how to run a review:

```sh
otacon install --all              # all three agents
otacon install --agent claude     # or just one: claude, codex, or opencode
```

**Plan a feature.** In your agent, run `/otacon` (or just ask it to plan something with
Otacon). It interviews you to lock down intent, drafts the plan, and hands you a local
review URL.

**Review and sign off.** Open the URL: answer the interview, leave inline comments, ask
questions, and diff revisions in the browser, or [from your phone](docs/PHONE-ACCESS.md).

When the plan is ready, choose how it ships:

- **Approve**: the plan lands committed in `docs/plans/`, ready for any implementer.
- **Approve & Implement**: the same agent builds it in an isolated git worktree, phase by phase, and opens a PR.

## Why Otacon

Native plan mode hands you a wall of terminal text without fully clarifying your intent, and asks you to bless it. When you share your feedback, the agent sends back the full plan again. Re-reviewing the next revision costs as much as the first read.

The native plan also mixes low-level implementation detail with high-level design. Serious engineering orgs don't work that way. They sign off on the interface, the blast radius, and the behavior, dig into the implementation only where it matters, and treat review as a back-and-forth rather than a one-shot blessing. Otacon brings that discipline to coding agents.

<table>
<tr>
<td width="50%" valign="top">

#### 📄 Plans you actually read

A wall of prose is easy to skim and impossible to vet. Otacon plans are modeled on the
design docs strong eng orgs actually review. They lead with the high-level interface and
the impact, fold the code-level detail into collapsible sections, and put visuals where
they carry weight.

</td>
<td width="50%" valign="top">

#### 💬 Comment, don't rubber-stamp

Select any passage and leave an inline comment. Your note is
captured and routed to the agent without breaking your reading flow. Comments batch into
**one** clean revision with a changelog. Need a
clarification, not a change? **Quick Ask** gets you an instant answer without touching the
plan. And each revision lands as a diff that shows only what changed since you last looked,
so you never dig through a wall of terminal text to find it.

</td>
</tr>
<tr>
<td width="50%" valign="top">

#### 🎙️ It interviews you first

Otacon grills
you before it writes a word of the plan. It interviews until you're aligned, then drafts. Every
decision traces back to the answer that produced it, and the interview ships
with the approved plan, so the _why_ is never lost.

</td>
<td width="50%" valign="top">

#### 📱 Review from your phone

The five minutes before you hit the road shouldn't block your agent. Reviews run over
Tailscale, so you can continue the review, comment, and sign off from your phone. Because it's your own tailnet, your plans never leave your own devices.
[Phone setup →](docs/PHONE-ACCESS.md)

</td>
</tr>
<tr>
<td width="50%" valign="top">

#### 🚀 From approved plan to shipped PR

Approval shouldn't be where the rigor ends. **Approve & Implement** carries the plan
straight into the build inside an isolated git worktree: the same agent walks the phases
with a fresh subagent per phase,
then opens a PR.

</td>
<td width="50%" valign="top">

#### 🔒 Private & free by construction

The daemon, CLI, and UI never call an LLM. All the intelligence runs in your existing
subscription-backed agent session, so Otacon adds **zero API spend** of its own. It's
local-first, so your plans stay on your machines.

</td>
</tr>
</table>
