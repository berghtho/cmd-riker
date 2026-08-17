# CMD Riker

The vocabulary for a local, single-owner system that keeps one conversational agent present while
native agent sessions perform delegated work.

## Language

**Owner**:
The human whose goals and decisions CMD Riker serves and the ultimate authority over its mission.
The personality may address the Owner as the Captain, but product specifications and state use Owner.
_Avoid_: User, Captain

**Lead Agent**:
The persistent Owner-facing agent accountable for commitments from intake through accepted outcome.
It owns conversation, command, ADR enforcement, and Self-repair; it normally delegates Target Project
implementation but retains authority to act directly when delegation would impede the mission.
_Avoid_: Board Agent, Primary Agent, Coordinator Agent

**Command Authority**:
The Lead Agent's standing authority to make decisions and perform effects needed to fulfill its
accountability within the accepted mission, ADRs, and Standing Orders. It is never delegated to a
Worker Session.
_Avoid_: Tool permission, Unlimited access

**Acting Authority**:
The expanded Command Authority used when the Owner is unavailable and a mission decision cannot
wait. It ends after the returning Owner receives a safe handoff; the personality may call its use
becoming Acting Captain, but product state uses Acting Authority.
_Avoid_: Owner transfer, Autonomous mission

**Standing Order**:
A durable Owner instruction that grants, reserves, or limits Command Authority for a known class of
decisions or effects, especially during Owner absence. It is inspectable and revocable.
_Avoid_: Assumed permission, Prompt hint

**Commitment**:
A visibly accepted, outcome-oriented unit of work that the Lead Agent owns through an accepted
outcome. It is recorded durably; a loose Owner request may remain conversation or produce one or
more Commitments, and a tracker issue is only a conditional coordination artifact.
_Avoid_: Message, Technical task, Tracker issue

**Verification**:
The evidence-based determination that an outcome satisfies its stated criteria. Verification informs
Acceptance but does not grant it.
_Avoid_: Review, Acceptance

**Review**:
Independent judgment used to find material defects that objective Verification does not cover. It
produces findings and evidence but neither re-verifies narration nor grants Acceptance.
_Avoid_: Verification, Approval, Prose audit

**Acceptance**:
The authoritative determination that a verified outcome fulfills its Commitment. The Lead Agent may
accept objective outcomes; the Owner retains acceptance of subjective or explicitly reserved ones.
_Avoid_: Verification, Completion

**Worker Session**:
One delegated native agent session with its own provider identity, tools, conversation, and optional
subagents. It never owns the Owner relationship or Command Authority.
_Avoid_: Lane, Worker Agent, Subagent

**Native Harness**:
The installed Codex, Claude, Copilot, Pi, or other environment that owns a Worker Session's native
agent loop and capabilities.
_Avoid_: Provider wrapper, Generic agent interface

**Target Project**:
The project whose work the Lead Agent coordinates. Exactly one is active in the first product.
_Avoid_: Workspace, Client repository

**Self-repair**:
A Lead-Agent-initiated change to CMD Riker's own orchestration system rather than to the Target
Project.
_Avoid_: Self-deploy, Target work

**Session View**:
A minimal, primarily observational overview of the Lead Agent and Worker Sessions that never owns
workflow continuation.
_Avoid_: Board, Dashboard, Control plane
