# Claude lifecycle and control evidence (2.1.229 era)

Accessed: **2026-08-17**. Scope is Claude Code CLI `2.1.229` and the separately
packaged Claude Agent SDK releases that bundle that CLI: TypeScript
`@anthropic-ai/claude-agent-sdk@0.3.229` and Python `claude-agent-sdk==0.2.137`.
The npm metadata explicitly maps TypeScript SDK `0.3.229` to Claude Code
`2.1.229`; the Python release changelog and `_cli_version.py` do the same for
Python SDK `0.2.137`. [M1] [M2] [M3] [M4]

The documentation pages are mutable. Era-specific conclusions below rely on
an explicit version threshold, a changelog entry present at the pinned tag, or
an exact-version package/source artifact; otherwise the status is uncertain.

## Scope distinctions

- **CLI protocol** below means Claude Code's documented non-interactive
  `-p`/`--print` stream-json interface and the bidirectional control protocol
  exposed by that binary. The raw control protocol is described in Anthropic's
  Agent SDK API reference, but is not independently specified as a stable CLI
  wire standard. [C1] [S1]
- **Agent SDK** means the separately versioned TypeScript and Python packages.
  They spawn a `claude` subprocess and communicate with it over stdio; they are
  not the Claude API Client SDK. [S2] [S3]
- **Conversation resume** restores persisted transcript/context. It is not a
  general guarantee that filesystem state, running processes, or external
  side effects are reconstructed or made exactly-once. Anthropic explicitly
  says SDK sessions persist conversation, not filesystem state. [S4]
- In the matrix, **unsupported** means no public operation is exposed for that
  boundary in the identified release; **uncertain** means first-party material
  does not establish a general contract. It does not claim the internal binary
  can never exhibit that behavior.

## Local probe

The probe ran on Windows in an empty disposable Git repository at
`%LOCALAPPDATA%\Temp\opencode\claude-lifecycle-probe-20260817`. The installed
native binary was the WinGet package executable for `Anthropic.ClaudeCode`; it
reported `2.1.229 (Claude Code)`. Claude Code was run with `--safe-mode` so
project and user customizations did not supply the observed behavior. The SDK
checks used an exact install of `@anthropic-ai/claude-agent-sdk@0.3.229`, whose
package metadata pins its bundled Claude Code version to `2.1.229`.

### CLI protocol observations

The basic protocol run used `-p --input-format stream-json --output-format
stream-json --verbose --safe-mode --tools "" --replay-user-messages` and sent
one UUID-stamped `user` message over stdin. It produced:

1. `command_lifecycle` states `queued`, `started`, and `completed` for the same
   command UUID;
2. a `system/init` frame identifying Claude Code `2.1.229`, the disposable
   working directory, active tools and permission mode, and capabilities
   `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, and
   `msg_lifecycle_v1`;
3. an assistant message and successful result carrying one stable session ID.

When two UUID-stamped user messages were written while a five-second Bash tool
call was active, the second emitted `queued` immediately and `started` only
after the tool result. It was then delivered into the active interaction and
both command UUIDs reached `completed`. This establishes asynchronous input and
observable queue state; consumers must not infer a fixed turn boundary merely
from enqueue order.

The raw control probe sent:

```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"interrupt","cancel_queued":true}}
```

while one command was active and a second UUID-stamped command was queued. The
CLI emitted `cancelled` for the queued command and returned:

```json
{"still_queued":[],"cancelled":["<queued-command-uuid>"]}
```

The active command ended as `cancelled` with terminal reason
`aborted_streaming`. This directly confirms receipt-bearing interruption and
capability-gated queued cancellation in the installed protocol.

### Background and crash observations

`claude --bg --safe-mode --tools Bash --permission-mode auto <prompt>` returned
a short background ID immediately. During a harmless 300-second PowerShell
sleep, `claude agents --json --all --cwd <probe-repo>` reported the background
ID, full session ID, PID, `kind: "background"`, `status: "busy"`, and
`state: "working"`. The installed command surface also exposed:

```text
claude attach <id>
claude logs <id>
claude stop <id>
claude respawn <id>|--all
```

Killing only the reported worker PID caused a supervisor restart. After 15
seconds, inventory showed the same background ID and session ID with a new PID,
and the supervisor roster recorded `attempt: 2`. The transcript contained this
meta-message:

```text
Continue from where you left off. Note: this session was automatically
restarted after its process exited unexpectedly; the user has not sent a new
message since the restart. Re-verify anything time-sensitive (branch state,
running processes, prior partial work) before continuing.
```

The replacement worker issued a new 300-second sleep command. It did not adopt
or prove completion of the command that was running when the first worker died.
The probe therefore confirms identity-preserving supervisor respawn, but also
demonstrates that respawn is not recovery of an arbitrary in-flight effect and
may lead the agent to repeat that effect. `claude stop <id>` then moved the
session to `state: "stopped"` while retaining its identity.

The non-TTY probe environment could inspect but not exercise the interactive
attach/detach keystrokes. Their process boundary is therefore documentation-
backed rather than locally observed end to end.

### Agent SDK observations

The exact TypeScript SDK package successfully pre-warmed its bundled CLI with
`startup()`, returned initialization data through `initializationResult()` (46
commands and five models in this environment), and completed a `WarmQuery` with
the expected `SDK_OK` result. Its public initialization response does not expose
the raw `system/init` capability array, so protocol consumers needing those
flags must observe the message stream rather than infer them from the SDK
package version.

With only `AskUserQuestion` enabled, a query generated one structured question
with a header, two labelled and described choices, and `multiSelect: false`.
The SDK invoked `canUseTool` with that structured input plus non-empty
`requestId` and `toolUseID`; returning `updatedInput.answers` with `Alpha`
resumed the query and produced `You selected: Alpha.` This is an observed SDK
host callback, not a standalone raw-CLI question protocol guarantee.

A streaming SDK query accepted `interrupt()` and returned
`{"still_queued":[]}`; its result ended with `error_during_execution` and
terminal reason `aborted_streaming`. The package declarations separately expose
`streamInput()`, `stopTask()`, `backgroundTasks()`, `reinitialize()`, and
`close()`. `close()` explicitly terminates the underlying CLI subprocess; no
public SDK operation detaches and later reattaches to that same subprocess.

## Evidence matrix

| Lifecycle/control area | Claude Code CLI / protocol at 2.1.229 | Agent SDK at the matching releases |
|---|---|---|
| Stream initialization and capability discovery | **Supported.** `--input-format stream-json` and `--output-format stream-json` select NDJSON input/output. From CLI `2.1.205`, init may include an open-ended `capabilities` array; at this era the documented values include `interrupt_receipt_v1` and, from `2.1.219`, `interrupt_cancel_queued_v1`. Consumers are told to feature-detect rather than compare versions. Although the documentation describes init as first except for startup events, the local run emitted command-lifecycle frames before init, so consumers must select `system/init` by type rather than position. [C1] [C2] [S1] [S5] | **Supported, with language differences.** TypeScript `query()` returns a `Query`; `startup()` can spawn and complete initialization before a prompt, `initializationResult()` reads initialization data, and `reinitialize()` repeats initialization and redelivers pending permission/dialog requests after a transport gap (CLI `2.1.195+`). Python `ClaudeSDKClient.connect()` performs the initialize control request and `get_server_info()` returns the result, but Python has no documented `startup()`/`WarmQuery`. [S1] [P1] [P2] [P3] |
| Streaming and queued user input | **Supported.** Stream-json input accepts messages while Claude is working, and `--replay-user-messages` acknowledges stdin messages on stdout. From SDK/CLI parity release `0.3.206`/`2.1.206`, `command_lifecycle` frames report UUID-stamped messages as `queued`, `started`, `completed`, `cancelled`, or `discarded`. The local run confirmed queue state but folded the waiting input into the interaction after a tool result, so enqueue order alone does not establish a distinct turn boundary. [C1] [S5] | **Supported.** TypeScript accepts `AsyncIterable<SDKUserMessage>` and exposes `streamInput()`; `shouldQuery: false` appends context without starting a turn. Python `ClaudeSDKClient` permits bidirectional `query()` calls on one open session. Single-string/single-message mode does not support dynamic queueing or real-time interruption. [S1] [S6] [P1] |
| Structured human questions | **Uncertain as a standalone raw-CLI contract.** The CLI documents `--permission-prompt-tool` for an MCP tool to handle non-interactive permission prompts, but its standalone CLI reference does not define a stable `AskUserQuestion` stdin/stdout exchange. The `can_use_tool` control request used by SDK hosts is evidence about the binary control protocol, not a separate promise for ordinary `claude -p` consumers. [C1] [P3] | **Supported.** `AskUserQuestion` reaches `canUseTool`/`can_use_tool`, pauses execution until the callback returns, and carries 1-4 questions with 2-4 options, labels/descriptions, and multi-select. The host returns the original questions plus an `answers` map or free-form response. It is unavailable to Agent-tool subagents. [S7] |
| Interrupt current work | **Supported through distinct mechanisms.** In an attached background session, `Ctrl+C` cancels the running response or shell command without detaching. A `SIGTERM` to `claude -p` aborts the turn, terminates running Bash process trees, runs `SessionEnd` hooks, and exits 143. A direct control-protocol `interrupt` has a receipt on `interrupt_receipt_v1`. [C2] [C3] [S1] | **Supported only in streaming mode.** TypeScript `Query.interrupt()` returns the receipt when advertised; `AbortController` cancels operations; `close()` forcefully ends the query and subprocess. Python `ClaudeSDKClient.interrupt()` sends the stop request and interrupted messages remain buffered until drained; its exact `0.2.137` API returns no receipt. [S1] [P1] [P3] |
| Cancel queued input | **Supported in the control protocol, not as a normal shell gesture.** A direct `interrupt` request with `cancel_queued: true` is honored when `interrupt_cancel_queued_v1` is advertised (`2.1.219+`), returning cancelled UUIDs and an empty `still_queued`. Earlier CLIs ignore the field. [S1] [S5] | **Unsupported through the public interrupt helpers; supported through the lower-level control protocol.** TypeScript's public `interrupt()` deliberately does not send `cancel_queued`; a host must drive the control protocol directly for that behavior. Python `0.2.137` sends plain `interrupt` and exposes neither the receipt nor `cancel_queued`. [S1] [P3] |
| Background task inventory and stop | **Supported at two levels.** `claude agents --json` inventories background sessions and their states. Inside stream-json/SDK sessions, `background_tasks_changed` (`2.1.203+`) carries the full live set whenever membership changes; it emits no startup snapshot. Per-task start/update/notification frames cover background Bash, monitors, and subagents. [C3] [S1] [S5] | **Supported in TypeScript; uncertain as a full inventory in Python.** TypeScript types the full-set event and exposes `stopTask(taskId)`. Python `0.2.137` exposes typed task-start/progress/notification/update messages and `stop_task()`, but its public reference does not establish a typed full-set startup inventory. [S1] [P1] [P3] |
| Detach and attach | **Supported for Agent View background sessions, unsupported for `-p` stream sessions.** Background sessions run without a terminal, `claude attach <id>` attaches, detaching does not stop them, and the supervisor owns them. `--bg` cannot be combined with `-p`, so a print/stream-json subprocess cannot be converted into this attachment boundary. [C1] [C3] | **Unsupported as a public SDK session operation.** The SDK's boundary is an app-owned subprocess and stdio connection. TypeScript `close()` terminates it; Python `disconnect()` closes it. The public APIs offer resume on a later subprocess, not detach/reattach to the same SDK subprocess. [S1] [S2] [P1] [P3] |
| Process crash and automatic respawn | **Supported only for supervisor-owned background sessions.** The per-user supervisor restarts unexpectedly exited dispatched sessions, subject to persisted terminal state and explicit-stop safeguards; ordinary foreground CLI sessions remain tied to their terminal. The restarted session is told it restarted. Manual `claude respawn <id>` restarts with the conversation intact. [C3] | **Unsupported for transparent respawn; supported for later conversation resume.** One SDK session maps to one subprocess. Process/connection failures surface as errors; a later `query(... resume=...)` or Python equivalent starts a new subprocess from a saved transcript. `SessionStore` can move transcripts across hosts, but mirror writes are best-effort and can emit `mirror_error`. [S2] [S4] [S8] [P2] [P3] |
| Recovery of in-flight effects after process loss | **Partial for named task transfers; unsupported as a general recovery contract.** The supervisor documents handoff for top-level background shell commands, dynamic workflows, and background subagents, while excluding monitors and shell commands started by a subagent. In the local unexpected-exit probe, a blocking top-level shell command was not adopted; the replacement agent issued it again. Ordinary conversation resume also excludes background Bash and monitor tasks. [C3] [C4] | **Uncertain beyond named task-state cases.** The TypeScript changelog says SDK resume restored background-agent, remote-agent, and MCP task state by `0.3.176`, but the session contract covers transcript/context persistence rather than filesystem persistence, process resurrection, transaction rollback, or deduplication of external side effects. File checkpointing is separate and itself does not cover Bash changes or most subagent edits. [S4] [S5] [C5] |

## Boundary details

### Initialization

The CLI init event reports session identity and configuration such as Claude Code
version, current directory, model, permission mode, tools, MCP status, commands,
skills, plugins, and protocol capabilities. Startup hook events may precede it,
and the local probe also observed command-lifecycle frames before it, so
`system/init` is not unconditionally the first physical output frame. [C2]

The SDK's initialize handshake adds host-side callbacks and definitions to the
same subprocess protocol. The exact Python `0.2.137` source sends hook callback
IDs, agent definitions, skill filtering, and SDK MCP server plumbing during
connection. A repeated initialization is intended for reconnection/redelivery;
pending request IDs may repeat and therefore do not establish exactly-once
callback delivery. [P2] [P3] [S1]

### Queue and cancellation semantics

An interrupt receipt is a snapshot. `still_queued` contains UUID-bearing main
thread messages that will continue after the interrupted turn; it can omit
messages without UUIDs and excludes subagent-addressed messages. Resending a
UUID reported as still queued creates a duplicate turn. With
`cancel_queued: true`, those messages move to `cancelled`; TypeScript's public
`interrupt()` does not request that stronger operation. [S1]

Interrupting Python does not clear already-produced output. The interrupted
turn's buffered messages and final result must be consumed before the next
query's response; documented terminal reasons are `aborted_streaming` or
`aborted_tools`. [P1] [M4]

### Conversation versus effects

CLI and SDK `continue`/`resume` reconstruct conversation history from the
transcript. SDK documentation expressly separates that from the filesystem;
forking also branches history, not files. CLI checkpointing is a separate
mechanism and tracks direct file-editing tools, not Bash filesystem changes or
most subagent edits. [S4] [C5]

For supervisor-owned CLI background sessions, Anthropic documents a narrower
effect handoff across process restart. That is not equivalent to replay safety:
some task classes carry over, some stop, and the restarted agent is prompted to
re-check time-sensitive state. No cited source promises atomic rollback,
exactly-once tools, or exactly-once external effects after a crash. [C3]

## Primary sources

All URLs were accessed on **2026-08-17**.

- **[M1] CLI npm metadata, exact version:** `@anthropic-ai/claude-code@2.1.229`.
  https://registry.npmjs.org/%40anthropic-ai%2Fclaude-code/2.1.229
- **[M2] TypeScript Agent SDK npm metadata, exact version:**
  `@anthropic-ai/claude-agent-sdk@0.3.229`, including
  `claudeCodeVersion: "2.1.229"`.
  https://registry.npmjs.org/%40anthropic-ai%2Fclaude-agent-sdk/0.3.229
- **[M3] Python Agent SDK package metadata, exact version:**
  `claude-agent-sdk==0.2.137`.
  https://pypi.org/pypi/claude-agent-sdk/0.2.137/json
- **[M4] Python Agent SDK changelog at `v0.2.137`:** identifies bundled Claude
  CLI `2.1.229` and the interrupt terminal reasons available by this release.
  https://raw.githubusercontent.com/anthropics/claude-agent-sdk-python/v0.2.137/CHANGELOG.md
- **[C1] Claude Code CLI reference:** stream-json flags, queued input,
  permission prompt tool, Agent View commands, resume, and `--bg`/`-p`
  incompatibility.
  https://code.claude.com/docs/en/cli-reference
- **[C2] Run Claude Code programmatically:** stream init, capability detection,
  partial output, SIGTERM behavior, and non-interactive background-task exit.
  https://code.claude.com/docs/en/headless
- **[C3] Agent View:** attach/detach, JSON inventory, supervisor process,
  respawn, and background-work handoff boundaries. Its version-history table
  records relevant behavior at versions no later than `2.1.229`, including
  restart safeguards (`2.1.211`), attach waiting (`2.1.210`), and handoff
  behavior (`2.1.198`).
  https://code.claude.com/docs/en/agent-view
- **[C4] CLI sessions:** what conversation resume restores and its explicit
  exclusion of background Bash and monitor tasks.
  https://code.claude.com/docs/en/sessions
- **[C5] CLI checkpointing:** tracked and untracked file effects.
  https://code.claude.com/docs/en/checkpointing
- **[S1] TypeScript Agent SDK API reference:** `Query`, initialization,
  capability flags, interrupt receipts, direct `cancel_queued`, task inventory,
  and message types.
  https://code.claude.com/docs/en/agent-sdk/typescript
- **[S2] Agent SDK hosting:** one subprocess per session, stdio ownership, local
  state, and restart persistence boundaries.
  https://code.claude.com/docs/en/agent-sdk/hosting
- **[S3] Agent SDK overview:** explicit distinction among Agent SDK, Claude Code
  CLI, Client SDK, and Managed Agents.
  https://code.claude.com/docs/en/agent-sdk/overview
- **[S4] Agent SDK sessions:** persisted conversation versus filesystem,
  continue/resume/fork, process-restart resume, and cross-host transcript use.
  https://code.claude.com/docs/en/agent-sdk/sessions
- **[S5] TypeScript Agent SDK changelog at `v0.3.229`:** exact era changes,
  including command lifecycle (`0.3.206`), task-set snapshots (`0.3.203`),
  interrupt receipts (`0.3.205`), queued cancellation (`0.3.219`), and earlier
  task-state restoration (`0.3.176`).
  https://raw.githubusercontent.com/anthropics/claude-agent-sdk-typescript/v0.3.229/CHANGELOG.md
- **[S6] Agent SDK streaming input:** streaming versus single-message behavior,
  queued messages, and interruption limitations.
  https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- **[S7] Agent SDK user input:** `canUseTool`, permission requests, and the
  structured `AskUserQuestion` contract.
  https://code.claude.com/docs/en/agent-sdk/user-input
- **[S8] Agent SDK session storage:** transcript mirroring, cross-host resume,
  best-effort writes, and `mirror_error` behavior.
  https://code.claude.com/docs/en/agent-sdk/session-storage
- **[P1] Python Agent SDK API reference:** `ClaudeSDKClient`, `interrupt()`,
  `stop_task()`, streaming input, buffering after interrupt, and session API.
  https://code.claude.com/docs/en/agent-sdk/python
- **[P2] Python `0.2.137` exact CLI-version source:**
  https://raw.githubusercontent.com/anthropics/claude-agent-sdk-python/v0.2.137/src/claude_agent_sdk/_cli_version.py
- **[P3] Python `0.2.137` exact client source:** initialize, query, interrupt,
  stop-task, server-info, and disconnect behavior.
  https://raw.githubusercontent.com/anthropics/claude-agent-sdk-python/v0.2.137/src/claude_agent_sdk/client.py
