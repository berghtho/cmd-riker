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

Build immutable Lead Agent and Recovery Actor bundles with an official Node `24.16.0` or newer
Node 24 runtime:

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

The builder refuses an unsupported Node runtime, records the exact supplied version, hashes every
final file, and emits strict separate manifests. The Lead Agent carries its runtime dependencies; the Recovery Actor bundle cannot contain
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

### What the installation changes

The installation is deliberately per-user and contained under `%LOCALAPPDATA%\CMD Riker`:

- `launcher\riker.cmd` is the Owner-facing command. It opens Pi in the current terminal.
- `launcher\supervise-hidden.vbs` starts the Recovery Actor without creating a console window.
- `versions\` contains immutable Lead Agent releases, including their pinned Node runtime and Pi
  dependencies.
- `protected\recovery-actor\` contains the separately versioned Recovery Actor and its pinned Node
  runtime.
- `state\` contains the authoritative SQLite state.
- `recovery\` contains activation journals, snapshots, and failed-candidate evidence.

Installation also registers the per-user Windows Task Scheduler entry
`\CMD Riker\Recovery Actor`. It has no boot or logon trigger and does not run until CMD Riker is
started. It is an on-demand singleton with four one-minute restart attempts. Its GUI script-host
wrapper remains invisible while the Recovery Actor supervises the Lead Agent. It is not a Windows
service, does not run as `SYSTEM`, and does not require administrator privileges.

The visible process chain is the current terminal, `riker.cmd`, and Pi. The background process chain
is Windows Task Scheduler, `wscript.exe`, the Recovery Actor, and the hosted Lead Agent. The
supervision layer does not hold provider credentials. Pi or a delegated native harness may access
configured model providers and forges; their credentials remain in the provider-owned CLI or Pi
credential store and are not copied into CMD Riker's SQLite state.

To make the command available as `riker`, explicitly add its launcher directory to the current
user's `PATH`, then open a new terminal:

```powershell
$launcher = "$env:LOCALAPPDATA\CMD Riker\launcher"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $launcher) {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$launcher", "User")
}
```

Running `riker` opens Pi as the single visible Owner interface and reconnects it to the same
supervised Lead Agent. `stop` durably prevents new effects before supervision ends.

```powershell
riker
riker inspect
riker stop
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

Uninstall reaches a safe stop, unregisters `\CMD Riker\Recovery Actor`, and removes binaries and
launcher material. It preserves Authoritative State, journals, snapshots, failed-state evidence,
and unresolved attempts. Destructive state removal and removing the launcher directory from the
user `PATH` are separate explicit Owner actions.

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

With Codex CLI `0.147.0` or newer authenticated through ChatGPT, the Lead Agent can delegate an
effectful assignment. When the Lead delegates without naming a Commitment, CMD Riker records the
covering Commitment with its declared `test` criterion automatically. CMD Riker records the
assignment's targets, effect classes, Authorized Write Root, Command Authority, time and cost
bounds, isolated-checkout baseline, and no-replay recovery constraint before launching Codex. A
clean secondary worktree or non-default branch executes in place; any other primary checkout —
dirty, detached, on the default branch, or without a provable default branch — automatically gets a
managed sibling Execution Checkout instead of a refusal. Immediately before
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

For a managed Execution Checkout, the durable Worker authority and effect intent are recorded before
`git worktree add`; the Worker receives only that detached, Commitment-attributed sibling worktree as
its Authorized Write Root. After a settled Worker result, CMD Riker proves that the Target Project
HEAD still matches the recorded baseline, reconciles the exact Git patch, disposes the worktree, and
only then runs Verification. Unrelated uncommitted Owner changes in the Target Project are preserved
and tolerated; only a change that touches the Worker's own paths differently stops automatic effects
and surfaces one material Owner intervention while preserving both checkouts. Each lifecycle step is
read back before retry after restart. Worker completion, failure, and required interventions are
pushed to the Owner interface as they happen instead of waiting for the next Owner turn.

## Lead Agent tools and skills

The Lead Agent holds its full native tool belt — read, bash, edit, write, grep, find, and ls —
rooted in the Target Project under its own Command Authority. It acts directly when that serves the
mission best; delegation to Worker Sessions is one option, never a prerequisite. The Owner's
installed Pi skills and the Target Project's context files are part of the Lead's working context,
and the Lead reads a skill's file itself when it uses one.

The Pi Owner interface also loads the installed Pi skills normally. Invoking `/skill:<name>` in the
`riker` terminal inlines that skill's content into the Owner turn.

CMD Riker ships its generic `design-council` skill and locks the complete
[`mattpocock/skills`](https://github.com/mattpocock/skills) package through APM. Materialize the
committed graph with APM 0.28.0 or newer:

```powershell
apm install --frozen --target agent-skills
apm audit --ci --no-policy
```

`apm.yml` declares the sources, `apm.lock.yaml` pins exact revisions and hashes, and
`.agents/skills/` is generated local package output.
