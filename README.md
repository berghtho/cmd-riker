# CMD Riker

Your persistent Number One for agent work.

CMD Riker is a local Lead Agent that remains conversational while it delegates Target Project
implementation to native Worker Sessions, monitors their work, and repairs its own orchestration
system when necessary.

Wayfinding is complete. The accepted map is [Design CMD Riker's product and
architecture](https://github.com/berghtho/cmd-riker/issues/22), and implementation is proceeding in
small end-to-end increments. The Owner-facing product is a TypeScript/Node modular monolith using
SQLite WAL state and pinned Pi `0.84.2` libraries behind CMD-Riker-owned seams.

OpBoard and `cli-context-flow` are research inputs, not compatibility constraints.

## Owner CLI

Install and verify the product:

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

An uninitialized state directory requires a secret-free `config.json`:

```json
{
  "targetProject": { "path": "C:\\path\\to\\target-project" },
  "modelSelection": {
    "provider": "openai-codex",
    "model": "gpt-5.4-mini",
    "api": "openai-codex-responses"
  },
  "modelPolicyRevision": "owner-policy-1"
}
```

Authenticate this provider through Pi first and verify its non-secret status:

```powershell
npm exec -- pi
# Run /login and choose OpenAI Codex, then exit Pi.
npm exec -- pi auth check --provider openai-codex --json
```

Pi's provider-owned `ModelRuntime` resolves and refreshes OAuth internally; credential values never
cross CMD-Riker-owned interfaces or durable state. Keyless loopback OpenAI-compatible endpoints are
also supported with `api: "openai-completions"` and a loopback `baseUrl`. Start the CLI with:

```powershell
npm start -- --state-dir C:\path\to\cmd-riker-state
```

Non-TTY stdin/stdout remains line-oriented for scripts. A real terminal uses the CMD-Riker-owned
`pi-tui` interface.

To make one production-path probe against the configured Model, run:

```powershell
npm run live-smoke -- --state-dir C:\path\to\cmd-riker-state
```

The smoke prompt is fixed unless `--prompt` is supplied. Missing configuration, unavailable Pi
authentication, or an unavailable Model produces a stable `CMD_RIKER_*` host diagnostic and no Lead
Agent prose.

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
