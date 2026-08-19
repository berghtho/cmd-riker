<img width="600" height="632" alt="riker-small" src="https://github.com/user-attachments/assets/d337c1ef-3c17-40c0-8800-3537eb40f47a" />

Your persistent Number One for agent work.

CMD Riker is a local Lead Agent that remains conversational while it delegates Target Project
implementation to native Worker Sessions, monitors their work, and repairs its own orchestration
system when necessary.

The Owner-facing product is a TypeScript/Node modular monolith using
SQLite WAL state and pinned Pi `0.84.2` libraries behind CMD-Riker-owned seams.

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
  "modelFallbacks": [],
  "modelRequirements": {
    "requiredCapabilities": ["text"],
    "minimumContextWindow": 1,
    "dataHandling": "supported-integrations",
    "maximumInputCostPerMillionUsd": null
  },
  "modelPolicyRevision": "owner-policy-1",
  "workerModelPolicy": {
    "revision": "worker-policy-1",
    "selection": {
      "provider": "openai",
      "model": "gpt-5.6-sol",
      "nativeHarness": "codex"
    }
  }
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

The Lead Model policy tries the configured default and then each fallback in order. Every candidate
must independently pass the configured capability, context, data-handling, cost, authentication,
identity, and availability gates; an unknown or failed gate makes only that candidate ineligible. A
fallback is attributed on the completed Lead turn together with the active policy revision.

The Lead Agent can visibly accept bounded conversational work as a durable Commitment. CMD Riker
records its `Committed -> Ready -> Active -> Verifying` history, verifies declared response
postconditions, and grants objective Acceptance itself. Criteria reserved for Owner judgment stop at
`Awaiting Acceptance` until a later Owner turn explicitly accepts them. Commitment state,
Verification evidence, Acceptance authority, and the concise conversation status survive restart.
Interrupted active work becomes reconciling with a recovery action; later Owner turns can resume,
pause, cancel, or supersede it through the same conversation.

For a typed Target Project test operation, install the Task CLI and declare the public Taskfile
mapping in `cmd-riker.operations.json` at the checkout root:

```json
{
  "version": 1,
  "operations": {
    "test": {
      "task": "test",
      "platforms": ["windows"],
      "artifacts": ["test-results.json"]
    }
  }
}
```

The `test` task must be public in a supported root `Taskfile.yml`/`Taskfile.yaml` variant. CMD Riker
verifies the checkout, current platform, Task version, resolved Taskfile, and declared task before it
atomically records the ready Operation Attempt and pending effect intent, claims a bounded dispatch
lease, and invokes Task. One Authorized Write Root cannot have overlapping or unresolved effects. `artifacts`
contains up to 32 checkout-relative file paths, each at most 16 MiB, whose SHA-256 changes are
attributed to the operation result; use an empty array when the operation has no declared file
artifact.

With pinned Codex CLI `0.147.0` authenticated through ChatGPT, the Lead Agent can delegate an
effectful assignment for an active Commitment that declares the `test` criterion. CMD Riker records
the assignment's targets, effect classes, Authorized Write Root, Command Authority, time and cost
bounds, isolated-checkout baseline, and no-replay recovery constraint before launching Codex. The
checkout must be clean and use a non-default branch or secondary Git worktree. Immediately before
`turn/start`, the production adapter requires Windows sandbox readiness and uses Codex `workspaceWrite`
with no additional writable roots, no command network, no temporary-directory exception, and approval
policy `never`. A real in-root/out-of-root probe runs under the same policy; failure to prove either
side stops before effect dispatch. The orchestrator interrupts the native attempt when its durable
deadline expires and retains effect uncertainty rather than claiming rollback.

Only the current Worker generation can settle the effect. A safely terminated, structured Worker
outcome must agree with a real non-empty Git diff against the recorded baseline and stay inside the
assigned targets. It then triggers the declared typed `test` operation, whose durable result provides
Verification and objective Acceptance. The Authorized Write Root remains reserved until that result is
linked to the Worker effect; restart resumes a not-yet-dispatched Verification without replaying the
Worker. Connection loss after dispatch leaves the effect unknown and reconciling; it is never
automatically replayed.

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
