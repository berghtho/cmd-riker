# Preserve Native Harness depth behind narrow orchestration seams

CMD Riker integrates each Native Harness through its own native control surface, including Codex
app-server, Claude stream JSON, and Copilot ACP. The
[harness inventory](https://github.com/berghtho/cmd-riker/issues/1) established that CMD Riker
normalizes only the orchestration facts it owns; native tools, conversations, subagents, and
provider-specific strengths remain available, while unsupported capabilities remain explicitly
unavailable rather than being simulated by a universal agent wrapper.

## Consequences

CMD Riker maintains separate adapters, compatibility probes, and honest capability differences. This
cost is accepted over a lowest-common-denominator API that would hide recovery gaps and discard the
depth for which the Owner chose a Native Harness.
