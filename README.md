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
    "provider": "local-openai",
    "model": "your-local-model-id",
    "api": "openai-completions",
    "baseUrl": "http://127.0.0.1:11434/v1"
  },
  "modelPolicyRevision": "owner-policy-1"
}
```

CMD Riker currently accepts only keyless loopback HTTP model endpoints. It does not load API keys,
tokens, credential files, or credential environment variables. Start the conversational CLI with:

```powershell
npm start -- --state-dir C:\path\to\cmd-riker-state
```

Non-TTY stdin/stdout remains line-oriented for scripts. A real terminal uses the CMD-Riker-owned
`pi-tui` interface.

To make one production-path probe against the configured local Model, run:

```powershell
npm run live-smoke -- --state-dir C:\path\to\cmd-riker-state
```

The smoke prompt is fixed unless `--prompt` is supplied. Missing configuration or an unavailable
local model produces a stable `CMD_RIKER_*` host diagnostic and no Lead Agent prose.

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
