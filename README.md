<img width="600" height="632" alt="riker-small" src="https://github.com/user-attachments/assets/d337c1ef-3c17-40c0-8800-3537eb40f47a" />

Your persistent Number One for agent work.

CMD Riker is a local Lead Agent that remains conversational while it delegates Target Project
implementation to native Worker Sessions, monitors their work, and repairs its own orchestration
system when necessary.

The Owner-facing product is a TypeScript/Node modular monolith using
SQLite WAL state and pinned Pi `0.84.2` libraries behind CMD-Riker-owned seams.

## Development

Install dependencies and verify a source checkout:

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

The build produces separate `dist/lead-agent` and `dist/recovery-actor` trees. The protected Recovery
Actor uses only Node built-ins and stays outside the Lead Agent version it supervises.

## Local Windows Installation

CMD Riker installs per Windows user from an Owner-supplied local build. It does not download releases,
start at boot or logon, install a service, require `SYSTEM`, or depend on a machine-wide Node runtime
after installation.

Build immutable Lead Agent and Recovery Actor bundles with official Node `24.17.0`:

```powershell
npm ci
npm run build
npm run build:local-release -- `
  --revision riker-0.1.0-local.1 `
  --node "C:\Program Files\nodejs\node.exe" `
  --lead-dist dist\lead-agent `
  --lead-node-modules node_modules `
  --actor-dist dist\recovery-actor `
  --output release\riker-0.1.0-local.1
```

The builder refuses another Node version, hashes every final file, and emits strict separate
manifests. The Lead Agent carries its runtime dependencies; the Recovery Actor bundle cannot contain
Pi, Codex, or another non-built-in dependency.

Prepare the secret-free configuration below, then install without starting the product:

```powershell
$release = Resolve-Path release\riker-0.1.0-local.1
$install = "$env:LOCALAPPDATA\CMD Riker"
& "$release\recovery-actor\runtime\node.exe" `
  "$release\recovery-actor\dist\lifecycle-cli.js" install `
  --install-root $install `
  --actor-bundle "$release\recovery-actor" `
  --lead-bundle "$release\lead-agent" `
  --config C:\path\to\config.json
```

The registered Task Scheduler entry is per-user, on-demand, singleton, and has a bounded Recovery
Actor restart policy. Launching again reconnects to the same Lead Agent. Closing the terminal only
detaches; `stop` durably prevents new effects before supervision ends.

```powershell
& "$install\launcher\riker.cmd" start
& "$install\launcher\riker.cmd" inspect
& "$install\launcher\riker.cmd" stop
```

Upgrade from another trusted local Lead Agent bundle. Compatibility and independent Review evidence
are explicit inputs:

```powershell
& "$install\launcher\riker.cmd" upgrade `
  --lead-bundle C:\path\to\next-release\lead-agent `
  --state-revision before-riker-0.1.1 `
  --compatibility-evidence "lossless migration and return path verified" `
  --review-evidence "independent risk-focused review passed"
```

The Activation Journal records exact actor, attempt, code, state, baseline, and write-generation
identity before cutover. A failed or interrupted candidate restores the immediate SQLite-native
baseline under a fresh generation; stale writers are fenced on every Authoritative State transaction.
Successful activation does not automatically promote the Recovery Baseline.

Uninstall reaches a safe stop, unregisters supervision, and removes binaries and launcher material.
It preserves Authoritative State, journals, snapshots, failed-state evidence, and unresolved attempts.
Destructive state removal is a separate Owner action.

```powershell
& "$install\launcher\riker.cmd" uninstall
```

Local bundles are trusted Owner inputs. Their hashes prove exact identity and detect changes; V1 does
not claim publisher authenticity, remote acquisition, automatic updates, or Recovery Actor
self-upgrade.

## Owner Configuration

An uninitialized installation or development state directory requires a secret-free `config.json`:

```json
{
  "targetProject": { "path": "C:\\path\\to\\target-project" },
  "forgeAuthorities": {
    "github": { "account": "owner-login", "repository": "owner/repository" },
    "azure": {
      "account": "owner@example.com",
      "subscriptionId": "00000000-0000-0000-0000-000000000000"
    }
  },
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
also supported with `api: "openai-completions"` and a loopback `baseUrl`. For source-checkout
development, start the CLI with:

```powershell
node src/cli.ts --state-dir C:\path\to\cmd-riker-state
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

The Lead Agent also exposes two typed, non-interactive Forge operations: one GitHub issue-comment
mutation through `gh`, and one Azure subscription inspection through `az`. Each adapter proves its
executable, authenticated identity, intended target, and required capability before use. GitHub
records durable effect intent before dispatch and succeeds only after an exact provider read-back;
Azure remains read-only. CMD Riker never accepts or persists credential values. A missing CLI,
authentication, or required interaction produces one deduplicated Owner action in the Session View.

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
