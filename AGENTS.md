# CMD Riker agent instructions

# What is CMD Riker

CMD Riker is a CLI platform to orchestrate available harnesses while a Lead agent, Riker, maintains control over them, acting as the owners surrogate in their absence.
Riker is able to perform any operation required to act on the owners behalf, monitoring, maintaining and orchestrating worker agents.

Before starting a new slice, fetch `origin`, fast-forward local `main` with `git pull --ff-only`, then
create or refresh the work branch. Preserve unrelated worktrees; when local `main` cannot be updated
safely, start from `origin/main` in a clean worktree instead of using a stale base.

Close an issue whose resolution includes code changes only after its linked pull request is merged.
Name the pull request and merge commit in the issue's durable resolution comment.

CMD Riker's wayfinding is complete and product implementation has begun. Read `CONTEXT.md` before
using a domain noun. The accepted product and architecture map is
[Design CMD Riker's product and architecture](https://github.com/berghtho/cmd-riker/issues/22);
use its linked resolution comments as the implementation constraints.

When shaping the Lead Agent's interaction, read `docs/product-principles.md`. Preserve the named
personality traits without turning domain language into Star Trek role-play.

## Agent skills

### Issue tracker

Issues live in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the standard five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

### Skill distribution

APM locks the complete Matt Pocock skill package plus CMD Riker's shipped `design-council`. See
`docs/agents/skills.md` before changing, installing, or resolving repository skills.
