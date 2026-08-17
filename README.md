# CMD Riker

Your persistent Number One for agent work.

CMD Riker is being designed as a local Lead Agent that remains conversational while it
delegates target-project implementation to native Worker Sessions, monitors their work,
and repairs its own orchestration system when necessary.

The project is currently in wayfinding. The canonical map is
[Design CMD Riker's product and architecture](https://github.com/berghtho/cmd-riker/issues/22).
No runtime, language, framework, or Pi integration has been selected yet.

OpBoard and `cli-context-flow` are research inputs, not compatibility constraints.

## Workflow skills

CMD Riker ships its generic `design-council` skill and locks the complete
[`mattpocock/skills`](https://github.com/mattpocock/skills) package through APM. Materialize the
committed graph with APM 0.28.0 or newer:

```powershell
apm install --frozen --target agent-skills
apm audit --ci --no-policy
```

`apm.yml` declares the sources, `apm.lock.yaml` pins exact revisions and hashes, and
`.agents/skills/` is generated local package output.
