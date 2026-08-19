import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";

test("Standing Orders explicitly bound Acting Authority and survive restart", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-acting-authority-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const orchestration = createOrchestrationCore(state);
  const ownerTurnId = state.appendOwnerMessage("While I am away, merge this bounded Commitment if it verifies.");
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The bounded change is integrated.",
    criteria: [{ kind: "response-includes", description: "Integration is reported.", expectedText: "integrated" }],
  });

  assert.equal(orchestration.actingAuthorityView(), undefined);
  const standingOrder = orchestration.recordStandingOrder(ownerTurnId, {
    title: "Integrate the verified change",
    instruction: "Merge the verified Commitment into main while I am unavailable.",
    commitmentIds: [commitment.id],
    effectClasses: ["merge"],
    targets: ["main"],
    maximumIncrementalSpendUsd: 0,
    validUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const acting = orchestration.beginActingAuthority(ownerTurnId, {
    commitmentIds: [commitment.id],
    standingOrderIds: [standingOrder.id],
  });
  assert.equal(acting.state, "active");

  orchestration.recordActingAuthorityEvent(acting.id, {
    kind: "decision",
    commitmentId: commitment.id,
    summary: "Proceed with the verified integration path.",
    evidence: ["The declared Verification passed."],
  });
  orchestration.recordActingAuthorityEvent(acting.id, {
    kind: "effect",
    commitmentId: commitment.id,
    summary: "Merged the verified branch.",
    evidence: ["Merge commit abc123 exists on main."],
    effect: {
      effectClass: "merge",
      target: "main",
      reversible: true,
      externallyBinding: false,
      incrementalSpendUsd: 0,
    },
  });
  assert.throws(
    () => orchestration.recordActingAuthorityEvent(acting.id, {
      kind: "effect",
      commitmentId: commitment.id,
      summary: "Publish an irreversible external release.",
      evidence: ["No applicable Standing Order exists."],
      effect: {
        effectClass: "externally-binding-effect",
        target: "public-release",
        reversible: false,
        externallyBinding: true,
        incrementalSpendUsd: 0,
      },
    }),
    /no applicable active Standing Order/i,
  );
  for (const [kind, summary] of [
    ["exception", "No ADR exception was required."],
    ["risk", "The merge may require a follow-up migration."],
    ["uncertainty", "Production deployment was not attempted."],
  ] as const) {
    orchestration.recordActingAuthorityEvent(acting.id, {
      kind,
      commitmentId: commitment.id,
      summary,
      evidence: ["Recorded during Acting Authority."],
    });
  }

  state.close();
  state = openAuthoritativeState(stateDirectory);
  const reopened = createOrchestrationCore(state);
  assert.equal(reopened.standingOrdersView()[0]?.id, standingOrder.id);
  assert.equal(reopened.actingAuthorityView()?.id, acting.id);
  const returnTurnId = state.appendOwnerMessage("I am back. Return command.");
  const handoff = reopened.prepareActingAuthorityHandoff(acting.id, returnTurnId);
  assert.deepEqual(handoff.decisions, ["Proceed with the verified integration path."]);
  assert.deepEqual(handoff.effects, ["Merged the verified branch."]);
  assert.equal(handoff.exceptions.length, 1);
  assert.equal(handoff.risks.length, 1);
  assert.equal(handoff.uncertainty.length, 1);
  assert.equal(reopened.actingAuthorityView()?.state, "handoff-pending");
  assert.throws(
    () => reopened.observeActingAuthorityHandoffDelivered(acting.id, ownerTurnId),
    /prepared Owner turn/i,
  );
  reopened.observeActingAuthorityHandoffDelivered(acting.id, returnTurnId);
  assert.equal(reopened.actingAuthorityView()?.state, "ended");

  const revokeTurnId = state.appendOwnerMessage("Revoke the old Standing Order.");
  reopened.revokeStandingOrder(standingOrder.id, revokeTurnId, "The bounded absence ended.");
  assert.equal(reopened.standingOrdersView()[0]?.state, "revoked");
  assert.throws(
    () => reopened.beginActingAuthority(revokeTurnId, {
      commitmentIds: [commitment.id],
      standingOrderIds: [standingOrder.id],
    }),
    /active Standing Order/i,
  );
  state.close();
});

function ownerConfiguration() {
  return {
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai" as const,
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "lead-policy-1",
  };
}
