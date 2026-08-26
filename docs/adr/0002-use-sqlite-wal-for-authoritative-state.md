# Use SQLite WAL for authoritative state and evidence-led effect recovery

CMD Riker keeps canonical conversation and orchestration state in SQLite WAL. As established by the
[state and effect kernel proof](https://github.com/berghtho/cmd-riker/issues/24), one transaction
records each authoritative transition and its resulting effect intents, while write generations
fence stale processes. An interrupted external effect becomes uncertain rather than failed or
retryable; provider evidence must reconcile it before another attempt, without claiming exactly-once
delivery.

## Consequences

This couples recovery to SQLite transactions, schema evolution, durable leases, and provider-specific
read-backs. The added machinery is accepted because blind retries can duplicate real effects, while
conversation or process recovery alone cannot prove what happened outside CMD Riker.
