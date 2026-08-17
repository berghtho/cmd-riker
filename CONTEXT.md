# CMD Riker

The vocabulary for a local, single-owner system that keeps one conversational agent present while
native agent sessions perform delegated work.

## Language

**Owner**:
The human whose goals and decisions CMD Riker serves. The personality may address the Owner as the
Captain, but product specifications and state use Owner.
_Avoid_: User, Captain

**Lead Agent**:
The persistent human-facing agent that owns the conversation, coordination, and Self-repair while
delegating implementation in the Target Project.
_Avoid_: Board Agent, Primary Agent, Coordinator Agent

**Worker Session**:
One delegated native agent session with its own provider identity, tools, conversation, and optional
subagents.
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
