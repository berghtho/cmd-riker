# Remove the protected Recovery Actor

CMD Riker guarded Self-repair with a protected external Recovery Actor process, Windows supervision
choreography, and staged health probation (~1,300 lines). The map
[Refocus CMD Riker on Lead Agent power](https://github.com/berghtho/cmd-riker/issues/57) reversed the
burden of proof: the named harm — Self-repair bricking the tool — is covered more cheaply by
versioned immutable installs, a one-command rollback, and the SQLite journal, so the external actor
and probation are removed. Self-repair verification is now green tests plus an available rollback.

## Consequences

The residual risk is Riker damaging its own rollback path; accepted because installs are immutable,
rollback data lives outside the running version, and the worst case is a manual reinstall. Reversal
would mean rebuilding the guardian process and its handoff protocol — meaningful cost, recorded here
so nobody reintroduces it casually without new evidence of the harm.
