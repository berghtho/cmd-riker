import assert from "node:assert/strict";
import test from "node:test";

import type {
  CapabilityNotice,
  Commitment,
  WorkerExecutionAttempt,
  WorkerQuestion,
  WorkerSession,
} from "../src/orchestration-core/index.ts";
import {
  createHealthAssessment,
  parseSessionViewControl,
  parseSessionViewInspection,
  parseSessionViewWorkerInspection,
  projectSessionView,
  renderSessionView,
  renderSessionWorkers,
  type SessionViewState,
} from "../src/session-view/index.ts";
import type { EffectIntent } from "../src/target-project-operations/index.ts";

test("running process presence contributes only to the quiet Worker count", () => {
  const worker = workerSession({ state: "running" });
  const attempt = workerAttempt(worker, {
    status: "running",
    process: { pid: 42, startedAt: "2026-08-19T10:00:00.000Z" },
  });
  const snapshot = projectSessionView(fakeState({ workers: [worker], attempts: [attempt] }), {
    assessedAt: "2026-08-19T10:01:00.000Z",
  });

  assert.equal(snapshot.activeWorkerCount, 1);
  assert.deepEqual(snapshot.exceptions, []);
  assert.doesNotMatch(renderSessionView(snapshot), /healthy/i);
});

test("uncertain effects expose scoped evidence, freshness, unknowns, and recovery", () => {
  const worker = workerSession({ state: "reconciling" });
  const attempt = workerAttempt(worker, { status: "continuity-lost" });
  const effect = workerEffect(worker, {
    status: "unknown",
    lease: {
      claimedAt: "2026-08-19T10:00:00.000Z",
      expiresAt: "2026-08-19T10:05:00.000Z",
    },
  });
  const snapshot = projectSessionView(
    fakeState({ workers: [worker], attempts: [attempt], effects: [effect] }),
    { assessedAt: "2026-08-19T10:01:00.000Z" },
  );

  const exception = snapshot.exceptions.find((item) => item.kind === "uncertain-effect");
  assert(exception);
  assert.deepEqual(exception.knownFacts, [
    "A bounded effect was dispatched and its durable status is unknown.",
  ]);
  assert.deepEqual(exception.unknowns, ["Whether the expected effect was applied."]);
  assert.deepEqual(exception.recoveryConditions, ["Reconcile before replay."]);
  assert.deepEqual(exception.healthAssessment, {
    subject: { kind: "effect-intent", id: effect.id, label: `Effect intent ${effect.id}` },
    scope: { kind: "commitment", id: "commitment-1", label: "Commitment commitment-1" },
    evidence: [{
      reference: `effect-intent:${effect.id}`,
      summary: "Authoritative effect status is unknown.",
      observedAt: "2026-08-19T10:00:00.000Z",
      bearing: "supports",
    }],
    freshness: {
      assessedAt: "2026-08-19T10:01:00.000Z",
      newestEvidenceObservedAt: "2026-08-19T10:00:00.000Z",
      expiresAt: "2026-08-19T10:01:00.000Z",
      status: "current",
    },
    verdict: "unknown",
  });
});

test("resolved effects and completed cancellations remove their exceptions", () => {
  const worker = workerSession({ state: "cancelled" });
  const attempt = workerAttempt(worker, { status: "cancelled" });
  const effect = workerEffect(worker, {
    status: "reconciled",
    reconciliation: {
      disposition: "confirmed-not-applied",
      evidence: {
        source: "target-project-readback",
        reference: "git:status",
        summary: "No change observed.",
        observedAt: "2026-08-19T10:02:00.000Z",
      },
      reconciledAt: "2026-08-19T10:03:00.000Z",
      reconciledBy: "lead-agent",
    },
  });
  const snapshot = projectSessionView(fakeState({ workers: [worker], attempts: [attempt], effects: [effect] }));

  assert.equal(snapshot.activeWorkerCount, 0);
  assert.deepEqual(snapshot.exceptions, []);
});

test("pause and cancel controls appear only in selected supported Worker details", () => {
  const worker = workerSession({ state: "running" });
  const attempt = workerAttempt(worker, {
    status: "running",
    capabilities: capabilities({ cancellation: true }),
  });
  const commitment = activeCommitment();
  const state = fakeState({ workers: [worker], attempts: [attempt], commitments: [commitment] });
  const snapshot = projectSessionView(state);
  const detail = snapshot.workers[0];

  assert(detail);
  assert.deepEqual(detail.actions.map((action) => action.kind), ["pause", "cancel"]);
  assert.equal(parseSessionViewControl(snapshot, detail.actions[0]!.command)?.targetId, commitment.id);
  assert.equal(parseSessionViewControl(snapshot, detail.actions[1]!.command)?.targetId, worker.id);
  assert.doesNotMatch(renderSessionView(snapshot), /Controls:/);
  const selected = parseSessionViewWorkerInspection(snapshot, `/session inspect worker:${worker.id}`);
  assert(selected);
  assert.match(renderSessionWorkers(snapshot, selected.id), /Controls:.*pause.*cancel/);

  const unsupportedAttempt = workerAttempt(worker, {
    status: "running",
    capabilities: capabilities({ cancellation: false }),
  });
  const pausedCommitment = { ...commitment, condition: { kind: "paused", reason: "Hold.", nextAction: "Wait." } } satisfies Commitment;
  const unsupported = projectSessionView(fakeState({
    workers: [worker],
    attempts: [unsupportedAttempt],
    commitments: [pausedCommitment],
  }));
  assert.deepEqual(unsupported.workers[0]?.actions, []);
});

test("active capability loss is scoped and clears with its authoritative fact", () => {
  const active: CapabilityNotice = {
    id: "codex-worker",
    state: "active",
    fingerprint: "safe-fingerprint",
    detail: "sensitive local diagnostic",
    targetProjectPath: "C:\\target-project",
    expectedIdentity: "ChatGPT",
    observedAt: "2026-08-19T10:00:00.000Z",
  };
  const snapshot = projectSessionView(fakeState({ capability: active }), {
    assessedAt: "2026-08-19T10:01:00.000Z",
  });

  assert.equal(snapshot.exceptions[0]?.healthAssessment?.verdict, "unavailable");
  const watchline = renderSessionView(snapshot);
  assert.doesNotMatch(watchline, /sensitive local diagnostic|C:\\target-project|Known:|Health Assessment:/);
  const inspection = parseSessionViewInspection(
    snapshot,
    `/session inspect ${snapshot.exceptions[0]?.id}`,
  );
  assert(inspection);
  assert.match(renderSessionView(snapshot, inspection.id), /Known:|Health Assessment:/);

  const stale = projectSessionView(fakeState({ capability: active }), {
    assessedAt: "2026-08-19T10:02:00.001Z",
  });
  assert.equal(stale.exceptions[0]?.healthAssessment?.freshness.status, "stale");
  assert.equal(stale.exceptions[0]?.healthAssessment?.verdict, "unknown");

  const cleared = projectSessionView(fakeState({ capability: { ...active, state: "cleared" } }));
  assert.deepEqual(cleared.exceptions, []);
});

test("a recorded pause remains only while Worker cessation is unsettled", () => {
  const worker = workerSession({ state: "waiting-question" });
  const attempt = workerAttempt(worker, {
    status: "running",
    capabilities: capabilities({ cancellation: true }),
  });
  const commitment = {
    ...activeCommitment(),
    condition: {
      kind: "paused" as const,
      reason: "Owner requested a pause.",
      nextAction: "Wait for the Owner.",
    },
  };
  const snapshot = projectSessionView(fakeState({
    workers: [worker],
    attempts: [attempt],
    commitments: [commitment],
  }));

  assert.deepEqual(snapshot.exceptions.map((item) => item.kind), ["pause-incomplete"]);
  assert.deepEqual(snapshot.exceptions[0]?.actions.map((action) => action.kind), ["cancel"]);
  assert.match(snapshot.exceptions[0]?.unknowns.join(" ") ?? "", /Worker.*ceased.*not established/);
});

test("a locally recoverable blocked Commitment does not interrupt the Owner", () => {
  const failed = workerSession({ state: "failed" });
  const replacement = workerSession({
    id: "worker-2",
    currentExecutionAttemptId: "attempt-2",
    state: "running",
  });
  const failedAttempt = workerAttempt(failed, { status: "failed" });
  const replacementAttempt = workerAttempt(replacement, { status: "running" });
  const blockedCommitment = {
    ...activeCommitment(),
    condition: {
      kind: "blocked" as const,
      reason: "The first Worker failed.",
      nextAction: "Replacement Worker owns recovery.",
    },
  };
  const recovered = projectSessionView(fakeState({
    workers: [failed, replacement],
    attempts: [failedAttempt, replacementAttempt],
    commitments: [blockedCommitment],
  }));
  assert.deepEqual(recovered.exceptions, []);

  const accepted = { ...activeCommitment(), state: "accepted" as const };
  const resolved = projectSessionView(fakeState({
    workers: [failed],
    attempts: [failedAttempt],
    commitments: [accepted],
  }));
  assert.deepEqual(resolved.exceptions, []);
});

test("reserved Owner decisions and non-Worker failures are material Commitment exceptions", () => {
  const awaiting = { ...activeCommitment(), state: "awaiting-acceptance" as const };
  const awaitingSnapshot = projectSessionView(fakeState({ commitments: [awaiting] }));
  assert.deepEqual(awaitingSnapshot.exceptions.map((item) => item.kind), ["reserved-owner-decision"]);
  assert.deepEqual(awaitingSnapshot.exceptions[0]?.actions, []);

  const blockedAwaiting = {
    ...awaiting,
    condition: {
      kind: "blocked" as const,
      reason: "Trusted Acceptance evidence is unavailable.",
      nextAction: "Restore the trusted evidence before an Owner verdict.",
      ownerAttention: "trusted-base-loss" as const,
    },
  };
  const blockedAwaitingSnapshot = projectSessionView(fakeState({ commitments: [blockedAwaiting] }));
  assert.deepEqual(blockedAwaitingSnapshot.exceptions.map((item) => item.kind), ["relevant-failure"]);
  assert.doesNotMatch(blockedAwaitingSnapshot.exceptions[0]?.recoveryConditions.join(" ") ?? "", /Accept/);

  const blocked = {
    ...activeCommitment(),
    condition: {
      kind: "blocked" as const,
      reason: "Lead turn failed.",
      nextAction: "Retry with changed evidence.",
      ownerAttention: "recovery-exhausted" as const,
    },
  };
  const blockedSnapshot = projectSessionView(fakeState({ commitments: [blocked] }));
  assert.deepEqual(blockedSnapshot.exceptions.map((item) => item.kind), ["relevant-failure"]);
  assert.equal(blockedSnapshot.exceptions[0]?.healthAssessment?.verdict, "unknown");
  assert.deepEqual(blockedSnapshot.exceptions[0]?.knownFacts, ["Lead turn failed."]);
  assert.deepEqual(blockedSnapshot.exceptions[0]?.recoveryConditions, ["Retry with changed evidence."]);

  const exhaustedWorker = workerSession({
    state: "blocked",
    ownerAttention: {
      kind: "recovery-exhausted",
      reason: "Automatic Worker recovery exhausted its bounded attempts.",
      nextAction: "The Owner must choose the next recovery strategy.",
    },
  });
  const exhaustedSnapshot = projectSessionView(fakeState({
    workers: [exhaustedWorker],
    attempts: [workerAttempt(exhaustedWorker, { status: "blocked" })],
    commitments: [activeCommitment()],
  }));
  assert.deepEqual(exhaustedSnapshot.exceptions.map((item) => item.id), ["worker-recovery:worker-1"]);

  const independentlyBlockedCommitment = {
    ...activeCommitment(),
    condition: {
      kind: "blocked" as const,
      reason: "Trusted project evidence is unavailable.",
      nextAction: "Restore the trusted evidence source.",
      ownerAttention: "trusted-base-loss" as const,
    },
  };
  const independentCauses = projectSessionView(fakeState({
    workers: [exhaustedWorker],
    attempts: [workerAttempt(exhaustedWorker, { status: "blocked" })],
    commitments: [independentlyBlockedCommitment],
  }));
  assert.deepEqual(independentCauses.exceptions.map((item) => item.id), [
    `commitment-blocked:${independentlyBlockedCommitment.id}`,
    `worker-recovery:${exhaustedWorker.id}`,
  ]);

  const recoveryWorker = workerSession({
    id: "worker-2",
    currentExecutionAttemptId: "attempt-2",
    assignment: {
      ...workerSession({}).assignment,
      coordination: {
        role: "recovery",
        recoveryOfWorkerSessionId: exhaustedWorker.id,
        reason: "A changed recovery hypothesis is assigned from dispatch.",
      },
    },
  });
  const owned = projectSessionView(fakeState({
    workers: [exhaustedWorker, recoveryWorker],
    attempts: [
      workerAttempt(exhaustedWorker, { status: "blocked" }),
      workerAttempt(recoveryWorker, { status: "running" }),
    ],
    commitments: [activeCommitment()],
  }));
  assert.deepEqual(owned.exceptions, []);
});

test("only explicitly Owner-reserved Worker questions enter attention", () => {
  const worker = workerSession({ state: "waiting-question" });
  const attempt = workerAttempt(worker, {
    status: "running",
    capabilities: capabilities({ cancellation: true }),
  });
  const routine = workerQuestion(worker);
  const reserved = {
    ...workerQuestion(worker),
    id: "question-2",
    ownerAttention: {
      kind: "owner-reserved-decision" as const,
      reason: "The Owner must choose the product boundary.",
    },
  };
  const snapshot = projectSessionView(fakeState({
    workers: [worker],
    attempts: [attempt],
    questions: [routine, reserved],
    commitments: [activeCommitment()],
  }));
  assert.deepEqual(snapshot.exceptions.map((item) => item.id), ["worker-question:question-2"]);
  assert.deepEqual(snapshot.exceptions[0]?.actions.map((action) => action.kind), ["pause", "cancel"]);
});

test("pause and cancellation absorb uncertain effects in the same scope", () => {
  const pausedWorker = workerSession({ state: "running" });
  const pausedCommitment = {
    ...activeCommitment(),
    condition: {
      kind: "paused" as const,
      reason: "Owner paused.",
      nextAction: "Wait.",
    },
  };
  const paused = projectSessionView(fakeState({
    workers: [pausedWorker],
    attempts: [workerAttempt(pausedWorker, { status: "running" })],
    commitments: [pausedCommitment],
    effects: [workerEffect(pausedWorker, {})],
  }));
  assert.deepEqual(paused.exceptions.map((item) => item.kind), ["pause-incomplete"]);

  const cancellingWorker = workerSession({
    state: "cancellation-requested",
    cancellation: {
      kind: "owner",
      requestedAt: "2026-08-19T10:00:00.000Z",
      requestedByOwnerTurnId: "turn-2",
      reason: "Stop.",
    },
  });
  const cancelling = projectSessionView(fakeState({
    workers: [cancellingWorker],
    attempts: [workerAttempt(cancellingWorker, { status: "running" })],
    commitments: [activeCommitment()],
    effects: [workerEffect(cancellingWorker, {})],
  }));
  assert.deepEqual(cancelling.exceptions.map((item) => item.kind), ["cancellation-incomplete"]);
});

test("conflicting health evidence forces an unknown verdict", () => {
  const health = createHealthAssessment({
    subject: { kind: "worker-capability", id: "codex-worker", label: "Codex Worker capability" },
    scope: { kind: "target-project", id: "configured-target-project", label: "Configured Target Project" },
    evidence: [
      {
        reference: "probe:unavailable",
        summary: "Probe failed.",
        observedAt: "2026-08-19T10:00:00.000Z",
        bearing: "supports",
      },
      {
        reference: "probe:available",
        summary: "A concurrent probe succeeded.",
        observedAt: "2026-08-19T10:00:10.000Z",
        bearing: "conflicts",
      },
    ],
    assessedAt: "2026-08-19T10:00:20.000Z",
    verdict: "unavailable",
  });
  assert.equal(health.freshness.status, "current");
  assert.equal(health.verdict, "unknown");
});

function fakeState(input: {
  workers?: WorkerSession[];
  attempts?: WorkerExecutionAttempt[];
  effects?: EffectIntent[];
  questions?: WorkerQuestion[];
  commitments?: Commitment[];
  capability?: CapabilityNotice;
}): SessionViewState {
  const attempts = new Map((input.attempts ?? []).map((attempt) => [attempt.id, attempt]));
  const commitments = new Map((input.commitments ?? []).map((commitment) => [commitment.id, commitment]));
  return {
    readWorkerSessions: () => input.workers ?? [],
    readWorkerExecutionAttempt: (id) => attempts.get(id),
    readWorkerQuestions: () => input.questions ?? [],
    readEffectIntents: () => input.effects ?? [],
    readCommitments: () => input.commitments ?? [],
    readCommitment: (id) => commitments.get(id),
    readCapabilityNotice: () => input.capability,
  };
}

function workerSession(overrides: Partial<WorkerSession>): WorkerSession {
  return {
    id: "worker-1",
    assignment: {
      objective: "Inspect the Target Project.",
      prompt: "Inspect only.",
      targetProjectPath: "C:\\target-project",
      modelPolicyRevision: "worker-policy-1",
      commitmentId: "commitment-1",
      readOnly: true,
    },
    state: "running",
    currentExecutionAttemptId: "attempt-1",
    ...overrides,
  };
}

function workerAttempt(
  worker: WorkerSession,
  overrides: Partial<WorkerExecutionAttempt>,
): WorkerExecutionAttempt {
  return {
    id: worker.currentExecutionAttemptId,
    workerSessionId: worker.id,
    generation: 1,
    modelSelection: { provider: "openai", model: "gpt-5.6-sol", nativeHarness: "codex" },
    modelPolicyRevision: "worker-policy-1",
    status: "running",
    ...overrides,
  };
}

function workerEffect(
  worker: WorkerSession,
  overrides: Partial<EffectIntent>,
): EffectIntent {
  return {
    id: "effect-1",
    kind: "worker-assignment",
    workerSessionId: worker.id,
    executionAttemptId: worker.currentExecutionAttemptId,
    commitmentId: "commitment-1",
    expectedEffect: "Apply a bounded Worker assignment.",
    authorizedWriteRootKey: "c:\\target-project",
    authorization: {
      kind: "lead-agent-command-authority",
      commitmentId: "commitment-1",
      targetProjectPath: "C:\\target-project",
      validatedAt: "2026-08-19T09:59:00.000Z",
    },
    retryRule: "Reconcile before replay.",
    status: "unknown",
    ...overrides,
  } as EffectIntent;
}

function activeCommitment(): Commitment {
  return {
    id: "commitment-1",
    outcome: "Inspect the Target Project.",
    criteria: [{
      id: "criterion-1",
      kind: "owner-judgment",
      description: "The Owner judges the result.",
    }],
    createdByOwnerTurnId: "turn-1",
    activeOwnerTurnId: "turn-1",
    state: "active",
  };
}

function workerQuestion(worker: WorkerSession): WorkerQuestion {
  return {
    id: "question-1",
    workerSessionId: worker.id,
    executionAttemptId: worker.currentExecutionAttemptId,
    providerRequestId: "request-1",
    itemId: "item-1",
    questions: [{ id: "q1", question: "Choose.", isOther: false }],
    status: "open",
  };
}

function capabilities(overrides: { cancellation: boolean }): NonNullable<WorkerExecutionAttempt["capabilities"]> {
  return {
    readOnly: true,
    nativeQuestions: true,
    cancellation: overrides.cancellation,
    providerSessionResume: true,
    providerSessionLoad: "unavailable",
    providerSessionDeletion: true,
    nativeChildControl: true,
    exactExecutionResume: "live-connection-only",
    protocolSchemaSha256: "schema",
  };
}
