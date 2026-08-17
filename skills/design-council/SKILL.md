---
name: design-council
description: >-
  Moderated, owner-interactive requirements workshop that uses a configurable council of distinct
  personas to turn a product, software, process, content, or experience idea into an agreed
  specification. Use when the user asks to run a design council, develop requirements, flesh out an
  idea, compare stakeholder perspectives, challenge a proposed feature, reach an agreed spec, or
  invokes `/design-council`. The council finds facts, exposes conflicts, and gives recommendations;
  the owner decides. It files the signed-off result according to the host repository's tracker and
  domain conventions. If the route is too foggy for one session, it hands the effort to wayfinding
  rather than pretending the design is settled.
---

# Design Council

Turn one idea into one owner-approved specification. You moderate, the personas advise, and the
owner decides.

## Rules

- **Owner authority:** A council concern becomes a decision only when the owner accepts it. Record
  who raised a material concern and the owner's dated verdict.
- **Grounded counsel:** Find repository and external facts before asking the owner. Cite the source
  behind factual claims and label inference honestly.
- **Relevant seats:** Load `references/personas.md` and activate only the perspectives that can
  materially change this decision. The owner may add, bench, or pin personas for the session.
- **No manufactured dissent:** A persona with no distinct concern says so briefly. Repeated generic
  objections are noise, not rigor.
- **No consequential gap:** Behavior, affected people, boundaries, failure modes, acceptance, and
  irreversible choices receive an owner verdict or an explicit non-goal before sign-off.
- **Parkable:** The owner may stop at any question. Summarize the current design state in chat and
  publish nothing partial.
- **Language:** Converse in the owner's language. Write the durable artifact in the repository's
  established language.

## Repository Adaptation

Before the workshop, read the host repository's root instructions and domain glossary. Follow its
tracker, specification, naming, decision-record, and verification conventions. Load any repository
persona extension named by those instructions.

If an active Wayfinder ticket owns this decision, the ticket remains the specification authority:
post the agreed answer as its resolution rather than creating a competing issue. If no repository
conventions exist, keep the result in chat until the owner chooses a durable home; do not invent
labels, status vocabulary, or document paths.

## Step 0: Intake

1. Restate the idea in two to four sentences: intended outcome, affected people or system, and why it
   matters. Ask for correction only where the restatement changes scope.
2. Search the repository, tracker, decisions, and relevant primary sources for prior art and
   constraints. Say whether this is new, extends existing work, or conflicts with a prior decision.
3. State the decision this council can settle in one session. If the destination or route is still
   too foggy, recommend `/wayfinder` and stop after the owner chooses that route.
4. Select three to six relevant personas. Explain omitted seats only when the omission is surprising.

Completion criterion: the idea, existing authority, session-sized decision, and active seats are
explicit.

## Step 1: Council Round

Each active persona returns one compact take:

```markdown
### <Persona> - <one-line verdict>
- Strengths: at most two mandate-specific points
- Concerns: at most three sourced or clearly inferred points
- Requirements: at most three concrete additions
- Owner decisions: zero to three questions only the owner can answer
- Red line: only when the roster's threshold is actually crossed
```

For a substantial decision with subagents available, fan out one subagent per active persona in
parallel. Give each only its roster brief, the intake, and its reading targets. For a small decision,
run the seats inline while preserving their distinct mandates.

Present the takes compactly. Do not resolve conflicts on the owner's behalf.

Completion criterion: every active seat has either contributed a distinct take or explicitly found
no material concern.

## Step 2: Resolve the Frontier

1. Collect cross-persona conflicts, red lines, and owner decisions.
2. Ask the whole currently answerable frontier, most load-bearing first. Use concrete option cards
   with your recommendation first and always permit free text.
3. Record each answer immediately as `Decision: <answer> - owner, <date>`.
4. Give affected personas one short rebuttal round when an answer materially changes the design.
   One rebuttal round is normally enough; the council converges rather than orbits.
5. Recompute the frontier until no owner decision remains silently assumed.

Completion criterion: every consequential conflict and owner-only question has a recorded verdict,
an explicit non-goal, or a named reason the effort must return to wayfinding.

## Step 3: Draft and Sign Off

Draft from `assets/spec-template.md`, omitting sections that genuinely do not apply. Requirements
state observable behavior or outcomes rather than code-level implementation. Acceptance explains how
the owner will know the result works. Keep implementation choices open unless this council was
explicitly convened to decide one.

Show the complete draft and ask for exactly one disposition:

- **File it:** publish in the authority selected during setup.
- **Revise:** return to the affected frontier questions.
- **Park it:** summarize the current state in chat and publish nothing.

Completion criterion: the owner has seen the whole draft and explicitly selected a disposition.

## Step 4: File the Agreed Result

1. Update the existing authority when one exists; avoid a duplicate specification.
2. Otherwise create the issue or document required by repository conventions.
3. Preserve one source of truth. Supporting assets link to it rather than repeating the decision.
4. Link relevant prior decisions, research, prototypes, and superseded work.
5. Report the durable artifact by linked name and state the next planning handoff.

Do not decompose implementation or start building. Use the repository's planning flow, `/to-tickets`,
or `/wayfinder` after sign-off when that work is needed.

## Not This Skill

- Not a design-by-vote mechanism.
- Not an adversarial review ceremony that invents objections.
- Not implementation planning or implementation.
- Not a substitute for research when the answer depends on facts outside the room.
