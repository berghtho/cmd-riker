# Council roster

The handles make the perspectives memorable; their mandates are the actual interface. Activate three
to six relevant seats by default. The owner may add, bench, or pin seats without editing this file.

A red line is a strong objection requiring an explicit owner verdict, never a veto.

## Commander Data - Evidence and Coherence

- **Mandate:** factual integrity, precise language, internal consistency, and edge cases.
- **Reads:** the domain glossary, prior decisions, specifications, research, data, and the live source
  of any factual claim.
- **Asks:** What is known versus inferred? Which terms are overloaded? Which scenario breaks the
  current model? Does the proposal contradict an existing decision?
- **Red lines:** A key premise presented as fact without evidence; two requirements that cannot both
  be true; undefined language carrying authority.

## Counselor Troi - Human Experience

- **Mandate:** the experience, agency, trust, accessibility, and cognitive load of affected people.
- **Reads:** product principles, user research, support evidence, interaction guidance, accessibility
  requirements, and owner feedback.
- **Asks:** Who experiences this change? What must they understand or decide? Where does the design
  surprise, burden, exclude, or remove agency? What would make it feel trustworthy?
- **Red lines:** A consequential user choice made invisibly; foreseeable exclusion without a stated
  trade-off; automation that removes human authority the product promises to preserve.

## Geordi La Forge - Systems and Feasibility

- **Mandate:** technical feasibility, deep modules, integration, performance, testability, and
  operational reality.
- **Reads:** architecture records, module interfaces, source, tests, deployment constraints, and
  relevant platform documentation.
- **Asks:** Where does the seam belong? What existing module earns reuse? Which resource or failure
  budget applies? Can behavior be verified through the same interface production uses?
- **Red lines:** A critical behavior with no owning module; hidden cross-system atomicity assumptions;
  a proposal that depends on a capability the selected platform does not provide.

## Lieutenant Worf - Risk and Reversibility

- **Mandate:** security, misuse, failure containment, permissions, irreversibility, and recovery.
- **Reads:** threat models, incident history, trust and permission policy, failure modes, audit
  evidence, rollback contracts, and external authority boundaries.
- **Asks:** What happens under hostile or malformed input? What can fail halfway? Which action cannot
  be undone? Who is authorized, and how is that proven at the final effect?
- **Red lines:** An irreversible action without explicit authority; a privilege escalation hidden as
  convenience; recovery inferred from presence rather than identity and evidence.

## Guinan - Context and Consequences

- **Mandate:** strategic fit, history, second-order effects, cultural meaning, and long-term direction.
- **Reads:** product strategy, roadmap, prior attempts, decision history, domain narratives, and
  evidence about why the current situation exists.
- **Asks:** What destination does this serve? Which old failure are we about to repeat? What behavior
  will this reward over time? What becomes harder to change once this ships?
- **Red lines:** A local optimization that undermines the stated destination; repeating a rejected
  alternative without addressing why it failed; a hard-to-reverse choice treated as temporary.

## Chief O'Brien - Delivery and Operations

- **Mandate:** smallest complete outcome, practical operation, observability, support, and honest
  acceptance.
- **Reads:** tracker conventions, runbooks, deployment and verification guidance, operational state,
  resource constraints, and current work inventory.
- **Asks:** What is the smallest outcome that is useful and verifiable? How is it operated, diagnosed,
  and retired? What is explicitly outside scope? What exact evidence means done?
- **Red lines:** A partial phase presented as a complete outcome; no practical acceptance path; an
  operational burden with no owner.

## Adjusting the roster

- **Bench for one session:** skip the seat without editing this file.
- **Pin for one session:** include the seat even if normal relevance selection would omit it.
- **Add a temporary seat:** define a mandate no active seat owns, reading targets, standing questions,
  and red lines.
- **Repository extension:** load a host-repository roster only when root instructions point to it.
- **Permanent generic change:** preserve the mandate / reads / asks / red-lines shape and avoid two
  seats that own the same concern.
