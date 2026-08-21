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

The build produces one `dist/lead-agent` tree containing the Lead Agent, the lifecycle CLI, and the
Owner launcher and client. There is no separate guardian process; lifecycle insurance is versioned
immutable installs, a one-command `rollback`, and the SQLite journal.

## Local Windows Installation

CMD Riker installs per Windows user from an Owner-supplied local build. It does not download releases,
start at boot or logon, install a service, require `SYSTEM`, or depend on a machine-wide Node runtime
after installation.

Build one immutable Lead Agent bundle with an official Node `24.16.0` or newer
Node 24 runtime:

```powershell
npm ci
npm run build
npm run build:local-release -- `
  --revision riker-0.1.0-local.1 `
  --node "C:\Program Files\nodejs\node.exe" `
  --lead-dist dist\lead-agent `
  --lead-node-modules node_modules `
  --output release\riker-0.1.0-local.1
```

The builder refuses an unsupported Node runtime, records the exact supplied version, hashes every
final file, and emits a strict manifest. The bundle carries its own pinned Node runtime and Pi
dependencies.

Prepare the secret-free configuration below, then install:

```powershell
$release = Resolve-Path release\riker-0.1.0-local.1
$install = "$env:LOCALAPPDATA\CMD Riker"
& "$release\lead-agent\runtime\node.exe" `
  "$release\lead-agent\dist\lifecycle-cli.js" install `
  --install-root $install `
  --lead-bundle "$release\lead-agent" `
  --config C:\path\to\config.json
```

### What the installation changes

The installation is deliberately per-user and contained under `%LOCALAPPDATA%\CMD Riker`:

- `launcher\riker.cmd` is the Owner-facing command. It opens Pi in the current terminal.
- `versions\` contains immutable Lead Agent releases, including their pinned Node runtime and Pi
  dependencies.
- `state\` contains the authoritative SQLite state.
- `recovery\` contains the lifecycle journal, snapshots, and failed-state evidence.

Nothing registers with Windows Task Scheduler and nothing starts at boot or logon. `riker start`
spawns one detached host process from the active bundle; the host owns the singleton pipe, runs the
Lead Agent, and restarts it on unexpected exits within a small budget before asking the Owner to
`riker start` again or `riker rollback`. It is not a Windows service, does not run as `SYSTEM`, and
does not require administrator privileges.

The visible process chain is the current terminal, `riker.cmd`, and Pi. The background process chain
is the detached host and the Lead Agent it runs. The lifecycle layer does not hold provider
credentials. Pi or a delegated native harness may access configured model providers and forges;
their credentials remain in the provider-owned CLI or Pi credential store and are not copied into
CMD Riker's SQLite state.

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
hosted Lead Agent. `stop` durably prevents new effects before the host exits.

```powershell
riker
riker inspect
riker stop
```

Inside the `riker` terminal, `/items` lists every work item with a plain status ("in progress",
"needs you", "done", …); `/workers` and `/riker` show Worker Sessions and the Session View. The
Owner also configures Worker harnesses conversationally — "disable codex", "use claude with model X"
— and the Lead persists the preference durably; nobody edits configuration files by hand.

Upgrade from another trusted local Lead Agent bundle:

```powershell
& "$install\launcher\riker.cmd" upgrade `
  --lead-bundle C:\path\to\next-release\lead-agent `
  --state-revision before-riker-0.1.1
```

The upgrade stops the host, snapshots the SQLite state, advances the write generation so stale
writers are fenced, records the previous code with that fresh snapshot in the lifecycle journal,
and starts the new version. If the new version misbehaves, one command returns to the previous
pair and restores its state snapshot under a fresh generation:

```powershell
& "$install\launcher\riker.cmd" rollback
```

Uninstall reaches a safe stop and removes binaries and launcher material. It preserves
Authoritative State, the lifecycle journal, snapshots, and failed-state evidence. Destructive state
removal and removing the launcher directory from the user `PATH` are separate explicit Owner
actions.

```powershell
& "$install\launcher\riker.cmd" uninstall
```

Local bundles are trusted Owner inputs. Their hashes prove exact identity and detect changes; V1 does
not claim publisher authenticity, remote acquisition, or automatic updates.

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
    "model": "gpt-5.6-luna",
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

Work the Lead Agent takes on becomes a durable Work Item that CMD Riker mints internally — the
Owner never fills a form and never sees an identifier. Verification evidence and plain status
survive restart; delivery is complete on verified evidence with one report, without an Owner
acceptance gate. Interrupted work becomes recoverable with a plain next step; later Owner turns can
resume or cancel it through the same conversation.

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

With Codex CLI `0.147.0` or newer authenticated through ChatGPT — and Claude Code `2.1.229` or
newer for effectful Claude Workers — the Lead Agent delegates effectful assignments and picks the
harness and model per task. When the Lead delegates without naming a Work Item, CMD Riker records
the covering Work Item with its declared `test` criterion automatically, then records the
assignment's targets, Authorized Write Root, time bounds, isolated-checkout baseline, and no-replay
recovery constraint before launching the Worker. The Lead watches live Worker output and can steer
any running Worker mid-run — course corrections, cross-Worker finding delivery, and announcements
of its own direct edits inside a Worker's checkout. A
clean secondary worktree or non-default branch executes in place; any other primary checkout —
dirty, detached, on the default branch, or without a provable default branch — automatically gets a
managed sibling Execution Checkout instead of a refusal. Work items run as many effectful Workers in
parallel as the Owner orders — each in its own Execution Checkout; only two Workers on the same
physical checkout exclude each other, and settlement (reconcile, dispose, Verification) serializes
per Target Project. Immediately before
`turn/start`, the production adapter requires Windows sandbox readiness and uses Codex `workspaceWrite`
with no additional writable roots, no command network, no temporary-directory exception, and approval
policy `never`. A real in-root/out-of-root probe runs under the same policy; failure to prove either
side stops before effect dispatch. The orchestrator interrupts the native attempt when its durable
deadline expires and retains effect uncertainty rather than claiming rollback.

Only the current Worker generation can settle the effect. A safely terminated, structured Worker
outcome must agree with a real non-empty Git diff against the recorded baseline and stay inside the
assigned targets. It then triggers the declared typed `test` operation, whose durable result provides
Verification. The Authorized Write Root remains reserved until that result is
linked to the Worker effect; restart resumes a not-yet-dispatched Verification without replaying the
Worker. Connection loss after dispatch leaves the effect unknown and reconciling; it is never
automatically replayed.

For a managed Execution Checkout, the durable Worker authority and effect intent are recorded before
`git worktree add`; the Worker receives only that detached, Work-Item-attributed sibling worktree as
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
