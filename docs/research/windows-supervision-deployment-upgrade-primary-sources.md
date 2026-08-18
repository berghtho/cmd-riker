# Windows supervision, deployment, and upgrade evidence

Accessed: **2026-08-18**. This report supplies planning evidence for
[Define process supervision, deployment, and upgrades][R1]. It does not
choose the product design or change an accepted decision.

The relevant accepted constraints are a TypeScript/Node modular monolith, a
separately versioned protected Recovery Actor, immutable repair candidates,
exact code-and-state pairing, exclusive write-generation handoff, external
health evaluation, and deterministic rollback. The interactive Owner-facing
surface is a per-user TUI. [R2] [R3] [R4]

## Established facts

### Windows services and interactive sessions

- All Windows services run in Terminal Services session 0. Since Windows Vista,
  services cannot directly interact with a user, and Microsoft says new code
  should not use interactive services. The supported pattern is a separate app
  in the interactive user's session communicating with the service over IPC;
  Microsoft warns that the IPC endpoint needs an appropriate ACL. [W1]
- Services use a noninteractive window station by default. A service UI would
  be visible only to a user connected to session 0, which Windows cannot
  guarantee on systems with Terminal Services or fast user switching. [W1]
- A task running as `SYSTEM` is likewise background-only: `SYSTEM` has no
  interactive logon rights, and users cannot see or interact with its program.
  [W2]

**Constraint:** a Windows service or `SYSTEM` task cannot itself own the
interactive per-user TUI. It would require a second user-session process and an
authenticated IPC protocol, introducing a privilege and lifecycle boundary
that the current single-owner product does not otherwise require.

### Task Scheduler

- Task Scheduler has distinct `ONSTART` and `ONLOGON` schedules. `ONSTART`
  triggers when the system starts; `ONLOGON` triggers when a user logs on and
  can be scoped to the run-as user. [W2]
- `TASK_LOGON_INTERACTIVE_TOKEN` requires the user to already be logged on and
  runs only in an existing interactive session. The `schtasks /it` option has
  the same run-only-while-the-run-as-user-is-logged-on meaning. [W2] [W3]
- `TASK_LOGON_S4U` stores no password but uses a noninteractive desktop and has
  no access to the network or encrypted files. `TASK_LOGON_PASSWORD` requires a
  password at registration. A non-administrator can register a task as their
  own account without supplying a password when using S4U or interactive logon;
  a low-privilege process cannot register a highest-run-level task. [W3] [W4]
- `RestartOnFailure` retries a failed task. Both a count and interval are
  required; the interval is at least one minute and at most 31 days. This is a
  bounded process restart facility, not a health assessment or effect-recovery
  protocol. [W5] [W6]
- A task can explicitly ignore, queue, parallelize, or replace an already
  running instance. `IGNORE_NEW` prevents a second instance while the first is
  running. [W7]
- `schtasks` does not verify the action's file path or account password when the
  task is created; a task may register successfully and later fail to run.
  [W2]

**Constraint:** an interactive TUI cannot be available before logon. An
interactive-token logon task can launch a per-user process without storing a
password, while an S4U or `SYSTEM` startup task cannot present that TUI. Task
Scheduler can restart the task action after failure, but its minimum retry
interval is one minute and its restart says nothing about the safety of an
interrupted external effect.

### Other first-party per-user process primitives

- `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` launches a command on
  each user logon. Windows does not guarantee prompt execution, may delay both
  `Run` entries and Startup-group programs, and does not define ordering among
  multiple `Run` entries. The command line is limited to 260 characters. [W8]
- A Windows Job Object can group a process tree, apply limits, collect
  accounting, terminate the group, and normally inherits child processes. With
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, closing the final job handle terminates
  associated processes. Job Objects do not provide a restart policy; most
  completion-port notifications are also not guaranteed. [W9]

**Constraint:** `Run` or the Startup group is sufficient for logon launch but
does not supervise the launcher. A long-lived Recovery Actor can use ordinary
child-process handles or a Job Object to contain and observe its Lead Agent
process tree, but it must itself implement restart budgets and recovery policy.

### Node.js distribution

- Node.js says production applications should use only Active LTS or
  Maintenance LTS releases. On the access date, v24.19.0 is LTS and v26.7.0 is
  Current. The Node project publishes official Windows x64 and Arm64 ZIP
  binaries and MSI installers for v24.19.0, plus signed release checksums. [N1]
  [N2]
- Shipping the official ZIP runtime with compiled/bundled JavaScript permits an
  app to pin its own `node.exe` without depending on the machine-wide Node
  installation. This is an inference from the official standalone ZIP artifact,
  not a Node deployment prescription. [N2]
- In the current LTS line, Node v24 single executable applications (SEA) remain
  **Stability 1.1, Active development**. They support one embedded CommonJS
  script, normally require bundling to one JavaScript file, and use an external
  resource injector such as `postject`. The injected script's default
  `require()` loads only built-ins; file-based loading requires `createRequire`.
  Native add-ons must be written to a temporary file before `process.dlopen()`.
  The blob and target Node binary must use the same Node version. [N3]
- SEA generation modifies the Node executable. Node's v24 procedure removes the
  existing Windows signature before injection and optionally signs the final
  executable afterward. [N3]
- Node v26 adds built-in `--build-sea` generation and supports a single embedded
  CommonJS or ECMAScript-module script, but SEA is still Stability 1.1. Node's
  own release guidance does not recommend the Current release line for
  production. [N1] [N4]

**Constraint:** SEA is a packaging optimization, not an updater or activation
mechanism. The least experimental pinned-runtime option is an immutable version
directory containing an official LTS `node.exe` plus the app's built output.
Choosing SEA on the current LTS line adds bundling, injection, native-addon, and
final-signing constraints; choosing v26 solely for newer SEA behavior conflicts
with Node's production release guidance.

### WinGet, MSI, MSIX, and activation primitives

- WinGet is a package-manager client that discovers packages and launches their
  EXE, ZIP, MSI, MSIX, portable, or other supported installer. A package
  manifest identifies an installer URL and mandatory SHA-256 hash. [P1] [P2]
- WinGet can request an exact version and can pin or gate upgrades. A WinGet pin
  only constrains WinGet: Microsoft explicitly says the app may still update
  itself or be updated outside WinGet. [P3] [P4]
- WinGet does not impose one upgrade topology. Microsoft documents that
  side-by-side installation versus removal of the old version depends on the
  individual installer, its manifest, and flags; otherwise the installer's
  default behavior applies. [P3]
- Windows Installer (MSI) automatically rolls back an **unsuccessful install**
  by default. Its rollback script and saved files are deleted after a successful
  installation, and custom actions require explicit rollback authoring. This is
  install-transaction rollback, not rollback after application probation or a
  failed health assessment. [P5]
- MSIX packages have versioned identity, are installed per user, and place
  package files in a protected read-only location. Package state is separate
  from binaries. Microsoft documents package updates as atomic replacement and
  says the app can be rolled back if needed. [P6] [P7] [P8]
- An MSIX update uses the same package family name. Normal update flow moves to
  a higher version; `ForceUpdateFromAnyVersion` permits staging or registering a
  lower version. Deployment can defer registration while the package is in use
  until next launch, or forcibly shut down the package's processes. [P9] [P10]
- An `.appinstaller` file can check on launch or through a background task every
  eight hours, prompt or update silently, and optionally permit downgrade.
  Without `ForceUpdateFromAnyVersion`, it moves only to a higher version. [P11]
- The Microsoft Store's documented rollback procedure stops new acquisition of
  a bad version but does not downgrade customers who already received it; those
  customers need another package with a higher version. [P12]
- `ReplaceFile` is a first-party primitive that replaces one file with another
  and can retain the old file as a backup. All three files must be on the same
  volume. Its nominal write-through flag is documented as unsupported. [P13]

**Constraints:**

- WinGet is a useful acquisition and outer install channel, but it does not
  guarantee side-by-side retention, health-gated activation, or rollback; those
  behaviors belong to the selected installer and CMD Riker's protocol.
- MSIX provides a stronger immutable and atomic package boundary than WinGet or
  a raw EXE. Its documented rollback is package deployment rollback, not the
  invariant-health, exact code-and-state, write-generation, and effect-barrier
  protocol established by [Define Self-repair authority and activation][R3] and
  [Prove the Recovery Actor cutover][R4]. Treating the Lead Agent and protected Recovery Actor
  as one MSIX package would also make them one update unit, contrary to their
  separately versioned boundary. These are design inferences from the documented
  package unit and the accepted recovery contract. [P6] [P8] [R3] [R4]
- MSI rollback ends when installation succeeds. It cannot supply the retained
  Recovery Baseline required through later probation and promotion. [P5] [R3]
- A custom side-by-side layout can use immutable version directories and a
  small replaceable activation-record file, but `ReplaceFile` alone does not
  establish power-loss durability because its write-through flag is unsupported.
  The Activation Journal remains necessary. [P13] [R4]

### Signing and integrity

- Authenticode signatures identify the distributor and establish that signed
  file content has not changed since signing. SignTool can sign, timestamp, and
  verify EXE, MSI, MSIX, scripts, and other Windows artifacts; verification can
  check trust and certificate revocation. Microsoft recommends SHA-256. [S1]
- Windows requires deployable MSIX packages to be signed and trusted on the
  device. The package publisher must correspond to the signing identity.
  Timestamping allows deployment to validate a signature at signing time after
  the signing certificate expires. Signed-package integrity can be enforced at
  runtime; Windows blocks launch and initiates repair when it detects tampering.
  [S2] [P8]
- WinGet manifests require an installer hash, and WinGet exposes an explicit,
  not-recommended option to ignore a hash-check failure. When not bypassed, a
  hash match establishes artifact equality to the manifest; Authenticode
  separately establishes signer identity and signed-file integrity. Neither
  establishes application health or authorization to activate a candidate.
  [P2] [P3] [S1]
- Because SEA injection changes the PE file and invalidates its inherited
  signature, any distributed SEA must be signed only after injection. [N3] [S1]

**Constraint:** artifact hashing and signature verification should precede an
Activation Attempt, but they cannot replace candidate identity, state
compatibility, external health, or recovery evidence. Signing the protected
Recovery Actor and each immutable Lead Agent artifact gives Windows-verifiable
publisher and integrity evidence; protection of the signing key and trusted
baseline remains an operational responsibility.

## Design inferences for the lifecycle decision

These are conclusions from the facts above, not guarantees stated by Windows or
Node.js.

1. **Prefer a per-user logon boundary, not a Windows service.** A Task Scheduler
   logon task using the Owner's interactive token can start the protected
   Recovery Actor in the same user session without a stored password or a
   third-party service wrapper. `IGNORE_NEW` prevents duplicate scheduled
   instances. A service is justified only if pre-logon work is required strongly
   enough to pay for a separate TUI process, IPC authentication, installation
   elevation, and cross-session lifecycle.
2. **Layer supervision.** Let Task Scheduler provide bounded, one-minute-or-
   slower restart of the Recovery Actor. Let the Recovery Actor provide prompt
   process supervision, restart budgeting, exact accepted-revision launch,
   reconciliation, activation, and rollback for the Lead Agent. Task Scheduler
   must never interpret process presence or exit as Health Assessment.
3. **Keep a simpler fallback explicit.** `HKCU\...\Run` or the Startup group can
   launch the Recovery Actor without task registration, but offers no recovery
   if that actor exits before the next logon. It is suitable only if manual
   restart and that availability gap are accepted.
4. **Ship the runtime with each immutable artifact.** A version directory that
   contains a pinned official LTS Node runtime and built app avoids a mutable
   machine-wide Node dependency. The separately versioned Recovery Actor needs
   its own protected runtime/artifact so a Lead Agent runtime update cannot
   remove the recovery path. SEA may be reconsidered after a pinned-LTS build
   proves its dependency and signing fit; it should not determine the lifecycle
   design.
5. **Separate acquisition, staging, and activation.** WinGet or MSIX can deliver
   signed bits, but the Recovery Actor must retain authority over staging,
   artifact verification, the durable activation intent, the write barrier,
   probation, and rollback. External WinGet invocations and automatic App
   Installer updates must not be allowed to replace the active protected actor
   or bypass an Activation Attempt.
6. **Use side-by-side immutable pairs for protocol rollback.** Keep the active
   candidate and protected Recovery Baseline as separate code-and-state pairs.
   Switch only a small journaled activation record after verification; do not
   patch active files. MSIX atomic package rollback and MSI failed-install
   rollback are useful outer guarantees but do not satisfy this protocol.
7. **Verify final artifacts, not source ingredients.** Hash and Authenticode-
   verify the exact EXE/MSIX/runtime bundle that will launch. For SEA, inject
   first and sign last. Signature success proves identity and integrity only;
   the Recovery Actor still evaluates the pre-recorded health contract.

## Evidence gaps requiring a disposable Windows probe

- Microsoft documents interactive-token semantics but does not establish how a
  console `ExecAction` will be presented across the intended Windows Terminal,
  console-host, lock/unlock, logoff, and fast-user-switching cases. Probe visible
  TUI launch/reattach and whether logoff terminates the task as expected.
- Probe which Node exit modes Task Scheduler classifies as restartable failure,
  confirm the count/interval budget survives actor restarts, and verify that
  `IGNORE_NEW` prevents duplicate actors during simultaneous logon/manual start.
- If MSIX remains a candidate, probe full-trust console/TUI activation, native
  child-process and Target Project access, deferred update while running, two
  independently versioned packages, and downgrade behavior. The docs establish
  the primitives, not their fit with CMD Riker's cutover protocol.
- Prove crash and power-loss behavior of the chosen activation-record update.
  `ReplaceFile` has documented failure states and no supported write-through
  option, so durable journaling cannot be inferred from a successful rename.

## Primary sources

All URLs were accessed on **2026-08-18**.

- **[R1] Define process supervision, deployment, and upgrades:**
  https://github.com/berghtho/cmd-riker/issues/17
- **[R2] Choose the system architecture and reuse boundary resolution:**
  https://github.com/berghtho/cmd-riker/issues/14#issuecomment-5320308892
- **[R3] Define Self-repair authority and activation resolution:**
  https://github.com/berghtho/cmd-riker/issues/20#issuecomment-5317924923
- **[R4] Prove the Recovery Actor cutover resolution:**
  https://github.com/berghtho/cmd-riker/issues/26#issuecomment-5327282938
- **[W1] Microsoft, Interactive Services:**
  https://learn.microsoft.com/windows/win32/services/interactive-services
- **[W2] Microsoft, `schtasks /create`:**
  https://learn.microsoft.com/windows-server/administration/windows-commands/schtasks-create
- **[W3] Microsoft, `TASK_LOGON_TYPE`:**
  https://learn.microsoft.com/windows/win32/api/taskschd/ne-taskschd-task_logon_type
- **[W4] Microsoft, Security Contexts for Tasks:**
  https://learn.microsoft.com/windows/win32/taskschd/security-contexts-for-running-tasks
- **[W5] Microsoft, Task Scheduler `RestartOnFailure`:**
  https://learn.microsoft.com/windows/win32/taskschd/taskschedulerschema-restartonfailure-settingstype-element
- **[W6] Microsoft, `TaskSettings.RestartInterval`:**
  https://learn.microsoft.com/windows/win32/taskschd/tasksettings-restartinterval
- **[W7] Microsoft, `TaskSettings.MultipleInstances`:**
  https://learn.microsoft.com/windows/win32/taskschd/tasksettings-multipleinstances
- **[W8] Microsoft, Run and RunOnce Registry Keys:**
  https://learn.microsoft.com/windows/win32/setupapi/run-and-runonce-registry-keys
- **[W9] Microsoft, Job Objects:**
  https://learn.microsoft.com/windows/win32/procthread/job-objects
- **[N1] Node.js releases:** https://nodejs.org/en/about/previous-releases
- **[N2] Node.js v24.19.0 archive:**
  https://nodejs.org/en/download/archive/v24.19.0
- **[N3] Node.js v24.19.0 SEA documentation:**
  https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html
- **[N4] Node.js v26 SEA documentation:**
  https://nodejs.org/docs/latest-v26.x/api/single-executable-applications.html
- **[P1] Microsoft, WinGet overview and supported installer formats:**
  https://learn.microsoft.com/windows/package-manager/winget/
- **[P2] Microsoft, WinGet package manifests:**
  https://learn.microsoft.com/windows/package-manager/package/manifest
- **[P3] Microsoft, WinGet `upgrade`:**
  https://learn.microsoft.com/windows/package-manager/winget/upgrade
- **[P4] Microsoft, WinGet `pin`:**
  https://learn.microsoft.com/windows/package-manager/winget/pinning
- **[P5] Microsoft, Windows Installer rollback:**
  https://learn.microsoft.com/windows/win32/msi/rollback-installation
- **[P6] Microsoft, What is MSIX?:**
  https://learn.microsoft.com/windows/msix/overview
- **[P7] Microsoft, MSIX containerization overview:**
  https://learn.microsoft.com/windows/msix/msix-containerization-overview
- **[P8] Microsoft, Package identity:**
  https://learn.microsoft.com/windows/apps/desktop/modernize/package-identity-overview
- **[P9] Microsoft, `Add-AppxPackage`:**
  https://learn.microsoft.com/powershell/module/appx/add-appxpackage
- **[P10] Microsoft, `DeploymentOptions`:**
  https://learn.microsoft.com/uwp/api/windows.management.deployment.deploymentoptions
- **[P11] Microsoft, App Installer update settings:**
  https://learn.microsoft.com/windows/msix/app-installer/update-settings
- **[P12] Microsoft, MSIX package versioning and Store rollback:**
  https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/app-package-requirements
- **[P13] Microsoft, `ReplaceFile`:**
  https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-replacefilew
- **[S1] Microsoft, code signing and SignTool:**
  https://learn.microsoft.com/windows/win32/seccrypto/cryptography-tools
  and https://learn.microsoft.com/windows/win32/seccrypto/signtool
- **[S2] Microsoft, MSIX signing and package integrity:**
  https://learn.microsoft.com/windows/msix/package/signing-package-overview
