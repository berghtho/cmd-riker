import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";

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

test("Standing Orders record from plain language, bind to the Owner's words, and survive restart", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-standing-order-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const orchestration = createOrchestrationCore(state);
  const validUntil = new Date(Date.now() + 60_000).toISOString();
  const ownerInstruction = "Merge verified changes to main while I am away.";
  const ownerTurnId = state.appendOwnerMessage(ownerInstruction);
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The verified change is integrated.",
    criteria: [{
      kind: "response-includes",
      description: "Integration is reported.",
      expectedText: "integrated",
    }],
  });

  assert.throws(
    () => orchestration.recordStandingOrder(ownerTurnId, {
      title: "Invented authority",
      instruction: "This was not requested.",
      commitmentIds: [commitment.id],
      effectClasses: ["merge"],
      targets: ["main"],
      allowIrreversibleEffects: false,
      allowExternallyBindingEffects: false,
      maximumIncrementalSpendUsd: 0,
      validUntil,
      ownerInstructionQuote: "Silence granted authority",
    }),
    /verbatim quote/i,
  );
  const standingOrder = orchestration.recordStandingOrder(ownerTurnId, {
    title: "Merge verified changes",
    instruction: ownerInstruction,
    commitmentIds: [commitment.id],
    effectClasses: ["merge"],
    targets: ["main"],
    allowIrreversibleEffects: false,
    allowExternallyBindingEffects: false,
    maximumIncrementalSpendUsd: 0,
    validUntil,
    ownerInstructionQuote: ownerInstruction,
  });
  state.close();

  state = openAuthoritativeState(stateDirectory);
  const reopened = createOrchestrationCore(state);
  assert.equal(reopened.standingOrdersView()[0]?.id, standingOrder.id);
  // An expired order also leaves the working context without a revocation.
  state.appendStandingOrderSnapshots([
    { ...state.readStandingOrders()[0]!, validUntil: new Date(Date.now() - 1_000).toISOString() },
  ]);
  assert.deepEqual(reopened.standingOrdersView(), []);
  state.appendStandingOrderSnapshots([standingOrder]);
  assert.equal(reopened.standingOrdersView()[0]?.id, standingOrder.id);

  const revokeTurnId = state.appendOwnerMessage("Revoke that Standing Order.");
  reopened.revokeStandingOrder(standingOrder.id, revokeTurnId, "The absence ended.");
  // A revoked order leaves the Lead's working context but stays in the journal.
  assert.deepEqual(reopened.standingOrdersView(), []);
  assert.equal(state.readStandingOrders()[0]?.state, "revoked");
  state.close();
});

test("a negated Owner instruction cannot create Standing Order authority", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-standing-order-negated-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const orchestration = createOrchestrationCore(state);
  const ownerInstruction = "Do not deploy anything today.";
  const ownerTurnId = state.appendOwnerMessage(ownerInstruction);
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The change is prepared.",
    criteria: [{
      kind: "response-includes",
      description: "Preparation is reported.",
      expectedText: "prepared",
    }],
  });

  assert.throws(
    () => orchestration.recordStandingOrder(ownerTurnId, {
      title: "Deploy authority",
      instruction: ownerInstruction,
      commitmentIds: [commitment.id],
      effectClasses: ["deploy"],
      targets: ["production"],
      allowIrreversibleEffects: false,
      allowExternallyBindingEffects: false,
      maximumIncrementalSpendUsd: 0,
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      ownerInstructionQuote: ownerInstruction,
    }),
    /negated effect class/i,
  );
  state.close();
});

test("Command Authority dispatches an effect without any Standing Order grant", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-command-dispatch-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-command-dispatch-project-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize({ ...ownerConfiguration(), targetProject: { path: checkout } });
  const orchestration = createOrchestrationCore(state);
  const ownerTurnId = state.appendOwnerMessage("Fix the bug.");
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The bugfix passes its declared test operation.",
    criteria: [{
      kind: "target-project-operation",
      description: "Tests pass.",
      operation: "test",
    }],
  });

  const { executionAttempt } = orchestration.delegateEffectfulWorker({
    objective: "Apply the bugfix.",
    prompt: "Change only src/app.ts.",
    targetProjectPath: checkout,
    modelSelection: { provider: "openai", model: "gpt-5.6-sol", nativeHarness: "codex" },
    modelPolicyRevision: "worker-policy-1",
    commitmentId: commitment.id,
    targets: ["src/app.ts"],
    timeoutMs: 60_000,
    checkoutIsolation: {
      root: checkout,
      baselineCommit: "a".repeat(40),
      isolation: { kind: "branch", branch: "codex/bugfix" },
    },
    verification: { operation: "test", workingDirectory: checkout, timeoutMs: 30_000 },
  });
  const effectIntent = state.readEffectIntent(executionAttempt.effectIntentId!);
  assert.equal(effectIntent?.status, "pending");
  assert.equal(effectIntent?.authorization.actingAuthority, undefined);
  state.close();
});
