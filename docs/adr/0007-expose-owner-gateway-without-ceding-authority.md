# Expose an Owner Gateway without ceding orchestration authority

External control surfaces attach to CMD Riker through a versioned local Owner Gateway. The gateway
projects the current Owner conversation and Session View, streams semantic changes, and accepts
host-correlated Owner turns. Its external protocol substitutes presentation-safe numbers for internal
state identifiers. The bundled Pi interface consumes the same gateway module.

Protocol v2 binds every external gateway process to one configured project through the required
`--project <absolute-path>` launcher argument. The child validates the canonical configured path and
any private Owner Session cursor carried by hosted framing. A gateway without a cursor observes the
latest active session in that project and creates a project-bound session only when its first semantic
turn needs one. Concurrent projects have separate conversation and Session View projections;
gateways attached to the same project retain private cursors when either selects or creates a session.
Internal session identifiers never cross the external protocol.
At attachment, the gateway resolves both the requested and configured existing paths to one real
filesystem identity. External snapshots and conversation events expose the requested identity's
canonical real path; configured path spelling remains internal for session validation.

CMD Riker remains authoritative for Owner Sessions, Command Authority, Work Items, Worker Sessions,
effects, and Verification. A control surface does not launch Native Harnesses, checkpoint Target
Project state, or maintain a competing workflow projection. Remote transport and authentication may
wrap the local gateway later without changing this ownership.

## Consequences

A T3 Code adapter can use its clients and connection infrastructure without treating the Lead Agent
as an ordinary provider thread or replacing CMD Riker's orchestration. The gateway protocol is a
shipped compatibility surface and must be versioned when its command or message meanings change.
Gateway attachment never infers scope from the terminal working directory and never silently falls
back to the Target Project.
