# CMD Riker agent instructions

CMD Riker is in wayfinding: decisions are being resolved before implementation begins. Read
`CONTEXT.md` before using a domain noun. The canonical map is
[Design CMD Riker's product and architecture](https://github.com/berghtho/cmd-riker/issues/22);
use the `/wayfinder` skill when charting or working through it.

Treat OpBoard and `cli-context-flow` as evidence sources, not inherited process. Implement product
code only after the map reaches its destination or its Notes explicitly bring execution into scope.
For planning and research, validate the decision artifact itself rather than inventing product tests
before a runtime exists.

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
