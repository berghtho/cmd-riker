# CMD Riker

The vocabulary for a local, single-owner system that keeps one conversational agent present while
native agent sessions perform delegated work.

## Language

**Owner**:
The human whose goals and decisions CMD Riker serves and the ultimate authority over its mission.
The personality may address the Owner as the Captain, but product specifications and state use Owner.
_Avoid_: User, Captain

**Lead Agent**:
The persistent Owner-facing agent accountable for delivering Work Items from request through
delivery. It owns the conversation, chooses Native Harnesses and Models per Delegation, orchestrates
parallel Worker Sessions, performs Self-repair, and acts directly when delegation would impede the
mission.
_Avoid_: Board Agent, Primary Agent, Coordinator Agent

**Command Authority**:
The Lead Agent's standing authority to decide and perform the effects its accountability requires,
bounded only by the accepted mission, ADRs, and Standing Orders. It applies whether the Owner is
present or absent; absence changes only the reporting duty. An irreversible effect without explicit
coverage takes the reversible variant. It is never delegated to a Worker Session.
_Avoid_: Acting Authority, Tool permission, Grant

**Standing Order**:
A durable plain-language Owner instruction that grants, reserves, or limits Command Authority for a
known class of decisions or effects. It is inspectable and revocable.
_Avoid_: Assumed permission, Prompt hint, Grant form

**Work Item**:
The durable record of one outcome the Lead Agent has agreed to deliver. Any number of parallel
Worker Sessions may serve one Work Item. The Owner speaks and hears plain language; identifiers
stay internal.
_Avoid_: Commitment, Tracker issue, Technical task

**Delegation**:
The Lead Agent's per-task assignment of an objective to a Worker Session, including its choice of
Native Harness and Model at that moment.
_Avoid_: Startup probe, Harness configuration

**Worker Session**:
One delegated native agent session with its own provider identity, tools, conversation, and optional
subagents. It never owns the Owner relationship or Command Authority.
_Avoid_: Lane, Worker Agent, Subagent

**Intervention**:
A Lead Agent action inside a running Worker Session: answering its question, steering it with a
message, or editing its Execution Checkout directly. Every direct edit is announced to the Worker
before it continues, so the Worker never reacts to unexplained changes.
_Avoid_: Cancel, Takeover

**Verification**:
The evidence-based check that a delivered outcome meets its stated criteria: tests, checks, and
read-backs, reported with the delivery. Independent review is a tactic the Lead Agent may delegate
when risk warrants it, not a lifecycle stage; delivery needs no Owner acceptance unless a Standing
Order reserves it.
_Avoid_: Acceptance, Review stage, Prose audit

**Native Harness**:
The installed Codex, Claude, Copilot, Pi, or other environment that owns a Worker Session's native
agent loop and capabilities.
_Avoid_: Provider wrapper, Generic agent interface

**Model**:
A provider-identified inference capability used for an agent turn. It is distinct from the Model
Provider and any Native Harness through which it is used.
_Avoid_: Provider, Native Harness, Agent

**Model Provider**:
The service or local backend that exposes Models and establishes their account, billing,
data-handling, and availability boundary.
_Avoid_: Model, Native Harness

**Model Policy**:
An Owner-controlled durable set of constraints and preferences governing which Models, Model
Providers, and Native Harnesses the Lead Agent may choose for itself and for Delegations.
_Avoid_: Model configuration, Router configuration

**Target Project**:
The project whose work the Lead Agent coordinates. Exactly one is active in the first product.
_Avoid_: Workspace, Client repository

**Execution Checkout**:
An isolated project checkout used as the sole write location for one effectful Worker Session while
the Target Project remains Owner-facing. It is what makes parallel effectful Workers safe; its
result is reconciled back before the checkout is disposed.
_Avoid_: Target Project, Working directory, Authorized Write Root

**Self-repair**:
A Lead-Agent-initiated change to CMD Riker's own orchestration system rather than to the Target
Project. It is verified by green tests plus an available one-command rollback of the versioned
install; no external guardian process supervises it.
_Avoid_: Self-deploy, Staged probation

**Session View**:
A minimal observational overview showing plain-language status of the Lead Agent and Worker
Sessions. It never owns workflow continuation and shows no internal identifiers.
_Avoid_: Board, Dashboard, Control plane, Attention ledger

**Owner Notice**:
A push message telling the Owner the moment work needs them or fails, delivered into the
conversation and as a native Windows notification under CMD Riker's own identity — never labeled
as a shell process. Durable state carries the fact; the notice itself is best-effort.
_Avoid_: Alert, Popup, Balloon tip
