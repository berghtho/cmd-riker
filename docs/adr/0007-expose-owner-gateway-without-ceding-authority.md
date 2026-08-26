# Expose an Owner Gateway without ceding orchestration authority

External control surfaces attach to CMD Riker through a versioned local Owner Gateway. The gateway
projects the current Owner conversation and Session View, streams semantic changes, and accepts
host-correlated Owner turns. Its external protocol substitutes presentation-safe numbers for internal
state identifiers. The bundled Pi interface consumes the same gateway module.

CMD Riker remains authoritative for Owner Sessions, Command Authority, Work Items, Worker Sessions,
effects, and Verification. A control surface does not launch Native Harnesses, checkpoint Target
Project state, or maintain a competing workflow projection. Remote transport and authentication may
wrap the local gateway later without changing this ownership.

## Consequences

A T3 Code adapter can use its clients and connection infrastructure without treating the Lead Agent
as an ordinary provider thread or replacing CMD Riker's orchestration. The gateway protocol is a
shipped compatibility surface and must be versioned when its command or message meanings change.
