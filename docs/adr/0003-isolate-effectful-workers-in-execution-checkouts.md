# Isolate effectful Worker Sessions in reconciled Execution Checkouts

Every effectful Worker Session receives one Execution Checkout as its sole write location. Following
the [Native Harness supervision boundary](https://github.com/berghtho/cmd-riker/issues/25), CMD Riker
may use a clean non-default branch in place or create a managed sibling Git worktree; it records the
checkout lifecycle, inventories the exact Worker patch, reconciles that patch into the Owner-facing
Target Project without overwriting unrelated Owner changes, and proves disposal afterward.

## Consequences

Execution Checkouts are both the parallel-write boundary and the result-reconciliation boundary. The
Git-specific lifecycle and provider-specific write-root enforcement cost more than a shared checkout,
but prevent concurrent Workers from damaging each other or the Owner-facing checkout.
