# Use pinned Pi as a substrate while CMD Riker owns authority and durability

As decided for the [Lead Agent runtime](https://github.com/berghtho/cmd-riker/issues/19), pinned Pi
libraries provide model turns, tool events, terminal primitives, and the visible Owner interface. CMD
Riker owns canonical conversations, Command Authority, Work Items, Worker supervision, and effect
recovery; Pi sessions and built-in workflow state are not authoritative, even where CMD Riker invokes
Pi's private CLI composition root so Pi owns the terminal experience.

## Consequences

Pi replaces a custom model loop and look-alike TUI, but its fast-moving private seam requires exact
version pins and upgrade proofs. Resuming Pi conversation state can never be treated as proof that an
interrupted external effect succeeded or failed.
