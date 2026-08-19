import assert from "node:assert/strict";
import test from "node:test";

import type {
  CapabilityNotice,
  Commitment,
  WorkerExecutionAttempt,
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

test("a recorded pause replaces its question with one incomplete-pause exception", () => {
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

test("a blocked Commitment remains visible until authoritative recovery resolves it", () => {
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
  assert.deepEqual(recovered.exceptions.map((item) => item.kind), ["relevant-failure"]);

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
  assert.deepEqual(awaitingSnapshot.exceptions[0]?.actions.map((action) => action.targetKind), ["commitment"]);

  const blocked = {
    ...activeCommitment(),
    condition: {
      kind: "blocked" as const,
      reason: "Lead turn failed.",
      nextAction: "Retry with changed evidence.",
    },
  };
  const blockedSnapshot = projectSessionView(fakeState({ commitments: [blocked] }));
  assert.deepEqual(blockedSnapshot.exceptions.map((item) => item.kind), ["relevant-failure"]);
  assert.equal(blockedSnapshot.exceptions[0]?.healthAssessment?.verdict, "unknown");
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
  commitments?: Commitment[];
  capability?: CapabilityNotice;
}): SessionViewState {
  const attempts = new Map((input.attempts ?? []).map((attempt) => [attempt.id, attempt]));
  const commitments = new Map((input.commitments ?? []).map((commitment) => [commitment.id, commitment]));
  return {
    readWorkerSessions: () => input.workers ?? [],
    readWorkerExecutionAttempt: (id) => attempts.get(id),
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
