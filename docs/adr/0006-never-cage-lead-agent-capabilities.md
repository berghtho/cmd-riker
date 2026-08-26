# Never cage the Lead Agent's native capabilities

The Lead Agent must retain every action that an ordinary Codex, Claude, Copilot, or equivalent native
agent run could perform in the Target Project. Typed adapters, declared operations, and other
orchestration tools are preferred because they leave durable evidence, but the
[Owner's adapters-are-never-a-cage decision](https://github.com/berghtho/cmd-riker/pull/80) makes them
non-exclusive: when they are missing, failed, or stuck, the Lead Agent may decide and act directly
with native tools under its Command Authority. The accepted mission, ADRs, and Standing Orders still
bound every action; only effects that genuinely require the Owner, such as restoring provider
credentials, return to the Owner.

## Consequences

A direct effect may bypass CMD Riker's durable effect ledger. The Lead Agent therefore reads back the
real result and reports that path plainly; a possible duplicate idempotent effect is preferable to an
unverified success claim. Capability controls must prevent a concrete named harm, not transfer the
Lead Agent's accountable decision to the Owner merely because an abstraction is incomplete.
