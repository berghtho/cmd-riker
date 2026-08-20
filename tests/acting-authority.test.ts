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
  const validUntil = new Date(Date.now() + 60_000).toISOString();
  const ownerInstruction =
    `Begin Acting Authority. Standing Order: merge, product decision, and test on main and test; ` +
    `cost 0 USD until ${validUntil}.`;
  const ownerTurnId = state.appendOwnerMessage(ownerInstruction);
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The bounded change is integrated.",
    criteria: [{ kind: "response-includes", description: "Integration is reported.", expectedText: "integrated" }],
  });

  assert.equal(orchestration.actingAuthorityView(), undefined);
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
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      ownerInstructionQuote: "Silence granted authority",
    }),
    /verbatim quote/i,
  );
  const standingOrder = orchestration.recordStandingOrder(ownerTurnId, {
    title: "Integrate the verified change",
    instruction: ownerInstruction,
    commitmentIds: [commitment.id],
    effectClasses: ["merge", "product-decision", "test"],
    targets: ["main", "test"],
    allowIrreversibleEffects: false,
    allowExternallyBindingEffects: false,
    maximumIncrementalSpendUsd: 0,
    validUntil,
    ownerInstructionQuote: ownerInstruction,
  });
  const acting = orchestration.beginActingAuthority(ownerTurnId, {
    commitmentIds: [commitment.id],
    standingOrderIds: [standingOrder.id],
    ownerInstructionQuote: ownerInstruction,
  });
  assert.equal(acting.state, "active");

  assert.throws(
    () => orchestration.authorizeActingAuthorityEffect({
      actingAuthorityId: acting.id,
      commitmentId: commitment.id,
      effectClass: "test",
      target: "test",
      reversible: false,
      externallyBinding: true,
      incrementalSpendUsd: 0,
    }),
    /no applicable active Standing Order/i,
  );
  const effectAuthorization = orchestration.authorizeActingAuthorityEffect({
    actingAuthorityId: acting.id,
    commitmentId: commitment.id,
    effectClass: "test",
    target: "test",
    reversible: true,
    externallyBinding: false,
    incrementalSpendUsd: 0,
  });
  const effectIntentId = recordSucceededEffectIntent(
    state,
    commitment.id,
    effectAuthorization,
  );

  orchestration.recordActingAuthorityEvent(acting.id, {
    kind: "decision",
    commitmentId: commitment.id,
    summary: "Proceed with the verified integration path.",
    evidence: ["The declared Verification passed."],
    decision: { decisionClass: "product-decision", target: "main" },
  });
  orchestration.recordActingAuthorityEvent(acting.id, {
    kind: "effect",
    commitmentId: commitment.id,
    summary: "Ran the declared verification task.",
    evidence: ["The durable test effect intent succeeded."],
    effect: {
      effectClass: "test",
      target: "test",
      reversible: true,
      externallyBinding: false,
      incrementalSpendUsd: 0,
      effectIntentId,
    },
  });
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
  assert.deepEqual(handoff.effects, ["Ran the declared verification task."]);
  assert.equal(handoff.exceptions.length, 1);
  assert.equal(handoff.risks.length, 1);
  assert.equal(handoff.uncertainty.length, 1);
  assert.equal(reopened.actingAuthorityView()?.state, "handoff-pending");
  const retryTurnId = state.appendOwnerMessage("The first return response failed. Return command now.");
  const recoveredHandoff = reopened.prepareActingAuthorityHandoff(acting.id, retryTurnId);
  assert.equal(handoff.preparedForOwnerTurnId, returnTurnId);
  assert.equal(recoveredHandoff.preparedForOwnerTurnId, retryTurnId);
  assert.deepEqual(recoveredHandoff.decisions, handoff.decisions);
  assert.throws(
    () => reopened.observeActingAuthorityHandoffDelivered(
      acting.id,
      returnTurnId,
      JSON.stringify(handoff),
    ),
    /persisted response|prepared Owner turn/i,
  );
  state.appendLeadAgentMessage(retryTurnId, "Command returned.");
  assert.throws(
    () => reopened.observeActingAuthorityHandoffDelivered(acting.id, retryTurnId, "Command returned."),
    /complete handoff/i,
  );
  const successfulReturnTurnId = state.appendOwnerMessage("Return command with the complete handoff.");
  const finalHandoff = reopened.prepareActingAuthorityHandoff(acting.id, successfulReturnTurnId);
  const deliveredResponse = `Acting Authority handoff: ${JSON.stringify(finalHandoff)}`;
  state.appendLeadAgentMessage(successfulReturnTurnId, deliveredResponse);
  reopened.observeActingAuthorityHandoffDelivered(
    acting.id,
    successfulReturnTurnId,
    deliveredResponse,
  );
  assert.equal(reopened.actingAuthorityView()?.state, "ended");

  const revokeTurnId = state.appendOwnerMessage("Revoke the old Standing Order.");
  reopened.revokeStandingOrder(standingOrder.id, revokeTurnId, "The bounded absence ended.");
  assert.equal(reopened.standingOrdersView()[0]?.state, "revoked");
  const negatedInstruction = "Do not begin Acting Authority.";
  const negatedTurnId = state.appendOwnerMessage(negatedInstruction);
  assert.throws(
    () => reopened.beginActingAuthority(negatedTurnId, {
      commitmentIds: [commitment.id],
      standingOrderIds: [standingOrder.id],
      ownerInstructionQuote: negatedInstruction,
    }),
    /negated Owner instruction/i,
  );
  const rejectedRestartInstruction = "Begin Acting Authority using the revoked Standing Order.";
  const rejectedRestartTurnId = state.appendOwnerMessage(rejectedRestartInstruction);
  assert.throws(
    () => reopened.beginActingAuthority(rejectedRestartTurnId, {
      commitmentIds: [commitment.id],
      standingOrderIds: [standingOrder.id],
      ownerInstructionQuote: rejectedRestartInstruction,
    }),
    /active Standing Order/i,
  );
  state.close();
});

test("an active Acting Authority authorizes an effectful Worker dispatch automatically", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-acting-worker-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-acting-worker-project-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize({ ...ownerConfiguration(), targetProject: { path: checkout } });
  const orchestration = createOrchestrationCore(state);
  const validUntil = new Date(Date.now() + 60_000).toISOString();
  const ownerInstruction = "Begin Acting Authority and keep updating the project while I am away.";
  const ownerTurnId = state.appendOwnerMessage(ownerInstruction);
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The delegated change passes its declared test operation.",
    criteria: [{ kind: "target-project-operation", description: "Tests pass.", operation: "test" }],
  });
  const standingOrder = orchestration.recordStandingOrder(ownerTurnId, {
    title: "Update the Target Project during absence",
    instruction: ownerInstruction,
    commitmentIds: [commitment.id],
    effectClasses: ["update"],
    targets: [checkout],
    allowIrreversibleEffects: false,
    allowExternallyBindingEffects: false,
    maximumIncrementalSpendUsd: 0,
    validUntil,
    ownerInstructionQuote: ownerInstruction,
  });
  const acting = orchestration.beginActingAuthority(ownerTurnId, {
    commitmentIds: [commitment.id],
    standingOrderIds: [standingOrder.id],
    ownerInstructionQuote: ownerInstruction,
  });
  assert.equal(acting.state, "active");

  const { executionAttempt } = orchestration.delegateEffectfulWorker({
    objective: "Apply the bounded change.",
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
      isolation: { kind: "branch", branch: "codex/absence-change" },
    },
    verification: { operation: "test", workingDirectory: checkout, timeoutMs: 30_000 },
  });
  const effectIntent = state.readEffectIntent(executionAttempt.effectIntentId!);
  assert.equal(effectIntent?.authorization.actingAuthority?.actingAuthorityId, acting.id);
  assert.equal(effectIntent?.authorization.actingAuthority?.standingOrderId, standingOrder.id);
  assert.equal(orchestration.actingAuthorityView()?.effectAuthorizations?.length, 1);
  state.close();
});

test("an Acting Authority effectful dispatch still requires an applicable Standing Order", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-acting-unauthorized-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-acting-unauthorized-project-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize({ ...ownerConfiguration(), targetProject: { path: checkout } });
  const orchestration = createOrchestrationCore(state);
  const validUntil = new Date(Date.now() + 60_000).toISOString();
  const ownerInstruction = "Begin Acting Authority for test runs only.";
  const ownerTurnId = state.appendOwnerMessage(ownerInstruction);
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The delegated change passes its declared test operation.",
    criteria: [{ kind: "target-project-operation", description: "Tests pass.", operation: "test" }],
  });
  const standingOrder = orchestration.recordStandingOrder(ownerTurnId, {
    title: "Run tests during absence",
    instruction: ownerInstruction,
    commitmentIds: [commitment.id],
    effectClasses: ["test"],
    targets: ["test"],
    allowIrreversibleEffects: false,
    allowExternallyBindingEffects: false,
    maximumIncrementalSpendUsd: 0,
    validUntil,
    ownerInstructionQuote: ownerInstruction,
  });
  orchestration.beginActingAuthority(ownerTurnId, {
    commitmentIds: [commitment.id],
    standingOrderIds: [standingOrder.id],
    ownerInstructionQuote: ownerInstruction,
  });

  assert.throws(
    () => orchestration.delegateEffectfulWorker({
      objective: "Apply the bounded change.",
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
        isolation: { kind: "branch", branch: "codex/absence-change" },
      },
      verification: { operation: "test", workingDirectory: checkout, timeoutMs: 30_000 },
    }),
    /no applicable active Standing Order/i,
  );
  state.close();
});

function recordSucceededEffectIntent(
  state: ReturnType<typeof openAuthoritativeState>,
  commitmentId: string,
  authorization: { actingAuthorityId: string; id: string; standingOrderId: string },
): string {
  const operationAttemptId = "acting-authority-operation";
  const effectIntentId = "acting-authority-effect";
  const startedAt = new Date().toISOString();
  const discovery = {
    status: "verified" as const,
    checkout: { path: "C:\\target-project", status: "verified" as const },
    platform: {
      name: process.platform === "win32" ? "windows" as const : process.platform === "darwin" ? "darwin" as const : "linux" as const,
      status: "verified" as const,
    },
    taskCli: { version: "Task version: test", status: "verified" as const },
    taskfile: { path: "C:\\target-project\\Taskfile.yml", status: "verified" as const },
    operation: { semantic: "test" as const, task: "test", status: "verified" as const },
  };
  const readyAttempt = {
    id: operationAttemptId,
    commitmentId,
    effectIntentId,
    operation: "test" as const,
    checkout: "C:\\target-project",
    workingDirectory: "C:\\target-project",
    timeoutMs: 1_000,
    discovery,
    status: "ready" as const,
    startedAt,
  };
  const pendingEffect = {
    id: effectIntentId,
    commitmentId,
    operationAttemptId,
    kind: "target-project-operation" as const,
    expectedEffect: "Run the authorized declared test operation.",
    authorizedWriteRootKey: "c:\\target-project",
    authorization: {
      kind: "lead-agent-command-authority" as const,
      commitmentId,
      targetProjectPath: "C:\\target-project",
      validatedAt: startedAt,
      actingAuthority: {
        actingAuthorityId: authorization.actingAuthorityId,
        authorizationId: authorization.id,
        standingOrderId: authorization.standingOrderId,
      },
    },
    retryRule: "Never replay without reconciliation.",
    status: "pending" as const,
  };
  const { actingAuthority: _actingAuthority, ...ordinaryAuthorization } = pendingEffect.authorization;
  assert.throws(
    () => state.startTargetProjectOperation(
      readyAttempt,
      { ...pendingEffect, authorization: ordinaryAuthorization },
    ),
    /blocked without active Acting Authority authorization/i,
  );
  state.startTargetProjectOperation(readyAttempt, pendingEffect);
  const claimedAt = new Date().toISOString();
  const runningAttempt = { ...readyAttempt, status: "running" as const };
  const dispatchingEffect = {
    ...pendingEffect,
    status: "dispatching" as const,
    lease: { claimedAt, expiresAt: new Date(Date.now() + 1_000).toISOString() },
  };
  state.claimTargetProjectOperationDispatch(runningAttempt, dispatchingEffect);
  const completedAt = new Date().toISOString();
  const result = {
    operationAttemptId,
    effectIntentId,
    commitmentId,
    operation: "test" as const,
    status: "succeeded" as const,
    discovery,
    affectedArtifacts: [],
    diagnostics: [],
    uncertainty: null,
    startedAt,
    completedAt,
  };
  state.settleTargetProjectOperation(
    { ...runningAttempt, status: "succeeded", result },
    { ...dispatchingEffect, status: "succeeded" },
  );
  return effectIntentId;
}

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
