import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openRecoveryActor,
  type ActivationEffects,
  type CodeStatePair,
  type HealthAssessment,
} from "../src/recovery-actor/index.ts";

const actorIdentity = {
  revision: "recovery-actor-1",
  digest: "a".repeat(64),
  path: "C:\\Riker\\recovery\\recovery-actor-1",
};

const baseline: CodeStatePair = {
  code: {
    revision: "riker-1",
    digest: "b".repeat(64),
    path: "C:\\Riker\\versions\\riker-1",
    runtime: { version: "24.17.0", architecture: "x64" },
  },
  state: {
    revision: "state-1",
    digest: "c".repeat(64),
    snapshotPath: "C:\\Riker\\recovery\\state-1.sqlite",
  },
};

const candidate: CodeStatePair = {
  code: {
    revision: "riker-2",
    digest: "d".repeat(64),
    path: "C:\\Riker\\versions\\riker-2",
    runtime: { version: "24.17.0", architecture: "x64" },
  },
  state: {
    revision: "state-1-for-riker-2",
    digest: "e".repeat(64),
    snapshotPath: "C:\\Riker\\recovery\\state-1-for-riker-2.sqlite",
  },
};

test("activation durably identifies the exact cutover before transferring the write generation", async (t) => {
  const installRoot = await mkdtemp(join(tmpdir(), "cmd-riker-activation-test-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const observations: string[] = [];
  let actor = openRecoveryActor(installRoot, actorIdentity, activationEffects({
    beforeGenerationTransfer: () => {
      const attempt = actor.inspect().currentAttempt;
      assert.equal(attempt?.phase, "generation-transfer-pending");
      assert.deepEqual(attempt?.actor, actorIdentity);
      assert.deepEqual(attempt?.candidate, candidate);
      assert.deepEqual(attempt?.baseline, baseline);
      assert.equal(attempt?.writeGeneration, 1);
      assert.equal(attempt?.authority.kind, "owner-supplied-upgrade");
      assert.equal(attempt?.compatibility.stateSchema, "lossless-return-proven");
      assert.equal(attempt?.review.verdict, "passed");
      assert.equal(attempt?.recoveryPath, "restore-exact-baseline-pair");
      observations.push("durable-before-transfer");
    },
  }, observations));
  actor.initialize({ active: baseline, recoveryBaseline: baseline, writeGeneration: 1 });

  const result = await actor.activate({
    candidate,
    authority: { kind: "owner-supplied-upgrade", authorizedAt: "2026-08-20T10:00:00.000Z" },
    compatibility: { stateSchema: "lossless-return-proven", evidence: "migration-check-1" },
    verification: { verdict: "passed", evidence: ["artifact-integrity", "state-backup"] },
    review: { verdict: "passed", evidence: ["independent-review-1"] },
    healthCriteria: [
      "exact-identity",
      "artifact-integrity",
      "authoritative-state",
      "write-generation",
      "conversation-context",
      "write-read-probe",
      "recovery-handshake",
    ],
    budget: { deadline: "2026-08-20T10:05:00.000Z", probationChecks: 2 },
    recoveryPath: "restore-exact-baseline-pair",
  });

  assert.equal(result.outcome, "activated");
  assert.deepEqual(observations, [
    "verify-candidate",
    "assess-barrier",
    "snapshot-state",
    "durable-before-transfer",
    "transfer-generation:1",
    "launch:riker-2:2",
    "health:riker-2:2",
    "probation:riker-2:2",
    "terminate:42",
  ]);
  assert.equal(actor.inspect().currentAttempt?.phase, "activated");
  assert.deepEqual(actor.inspect().active, candidate);
  assert.deepEqual(actor.inspect().recoveryBaseline, baseline);
  assert.equal(actor.inspect().writeGeneration, 2);
  actor.close();

  actor = openRecoveryActor(installRoot, actorIdentity, activationEffects({}, []));
  assert.equal(actor.inspect().currentAttempt?.id, result.attemptId);
  assert.equal(actor.inspect().currentAttempt?.phase, "activated");
  assert.deepEqual(actor.inspect().active, candidate);
  actor.close();
});

test("failed candidate health restores the exact protected pair under a fresh generation", async (t) => {
  const installRoot = await mkdtemp(join(tmpdir(), "cmd-riker-rollback-test-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const observations: string[] = [];
  const effects = activationEffects({ healthVerdict: "impaired" }, observations);
  const actor = openRecoveryActor(installRoot, actorIdentity, effects);
  actor.initialize({ active: baseline, recoveryBaseline: baseline, writeGeneration: 1 });

  const result = await actor.activate(activationRequest());

  assert.equal(result.outcome, "rolled-back");
  assert.equal(actor.inspect().currentAttempt?.phase, "rolled-back");
  assert.match(actor.inspect().currentAttempt?.failure ?? "", /Candidate invariant health is impaired/);
  assert.deepEqual(actor.inspect().active, baseline);
  assert.deepEqual(actor.inspect().recoveryBaseline, baseline);
  assert.equal(actor.inspect().writeGeneration, 3);
  assert.deepEqual(observations.slice(-6), [
    "health:riker-2:2",
    "terminate:42",
    "restore:riker-1:2",
    "launch:riker-1:3",
    "health:riker-1:3",
    "terminate:42",
  ]);
  actor.close();
});

test("actor restart reconciles a transferred generation from the durable attempt without replay", async (t) => {
  const installRoot = await mkdtemp(join(tmpdir(), "cmd-riker-actor-restart-test-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const observations: string[] = [];
  const hooks = { currentGeneration: 1, crashAfterGenerationTransfer: true };
  let actor = openRecoveryActor(installRoot, actorIdentity, activationEffects(hooks, observations));
  actor.initialize({ active: baseline, recoveryBaseline: baseline, writeGeneration: 1 });
  await assert.rejects(actor.activate(activationRequest()), /simulated Recovery Actor exit/);
  assert.equal(actor.inspect().currentAttempt?.phase, "generation-transfer-pending");
  actor.close();

  hooks.crashAfterGenerationTransfer = false;
  actor = openRecoveryActor(installRoot, actorIdentity, activationEffects(hooks, observations));
  const result = await actor.recover();

  assert.equal(result.outcome, "rolled-back");
  assert.equal(actor.inspect().currentAttempt?.phase, "rolled-back");
  assert.equal(actor.inspect().writeGeneration, 3);
  assert.equal(observations.filter((entry) => entry === "transfer-generation:1").length, 1);
  assert.match(observations.join("\n"), /restore:riker-1:2/);
  actor.close();
});

test("Lead Agent restart budget is durable and separate from Recovery Actor restart", async (t) => {
  const installRoot = await mkdtemp(join(tmpdir(), "cmd-riker-lead-budget-test-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  let actor = openRecoveryActor(installRoot, actorIdentity, activationEffects({}, []));
  actor.initialize({ active: baseline, recoveryBaseline: baseline, writeGeneration: 1 });

  assert.deepEqual(actor.recordLeadFailure("riker-1", "first crash"), {
    remaining: 2,
    exhausted: false,
  });
  actor.recordLeadFailure("riker-1", "second crash");
  assert.deepEqual(actor.recordLeadFailure("riker-1", "third crash"), {
    remaining: 0,
    exhausted: true,
  });
  actor.close();

  actor = openRecoveryActor(installRoot, actorIdentity, activationEffects({}, []));
  assert.equal(actor.inspect().leadRestartBudget?.remaining, 0);
  assert.equal(actor.inspect().leadRestartBudget?.failures.length, 3);
  actor.resetLeadRestartBudget(2);
  assert.deepEqual(actor.inspect().leadRestartBudget, {
    revision: "riker-1",
    limit: 2,
    remaining: 2,
    failures: [],
  });
  actor.close();
});

test("actor restart recognizes a completed exact baseline restore without restoring twice", async (t) => {
  const installRoot = await mkdtemp(join(tmpdir(), "cmd-riker-restore-restart-test-"));
  t.after(() => rm(installRoot, { recursive: true, force: true }));
  const observations: string[] = [];
  const hooks = {
    currentGeneration: 1,
    healthVerdict: "impaired" as const,
    crashAfterBaselineRestore: true,
    restoredGeneration: undefined as number | undefined,
  };
  let actor = openRecoveryActor(installRoot, actorIdentity, activationEffects(hooks, observations));
  actor.initialize({ active: baseline, recoveryBaseline: baseline, writeGeneration: 1 });
  await assert.rejects(actor.activate(activationRequest()), /simulated exit after baseline restore/);
  assert.equal(actor.inspect().currentAttempt?.phase, "rollback-restore-pending");
  actor.close();

  hooks.crashAfterBaselineRestore = false;
  actor = openRecoveryActor(installRoot, actorIdentity, activationEffects(hooks, observations));
  const result = await actor.recover();

  assert.equal(result.outcome, "rolled-back");
  assert.equal(observations.filter((entry) => entry === "restore:riker-1:2").length, 1);
  assert.equal(actor.inspect().writeGeneration, 3);
  actor.close();
});

function activationRequest() {
  return {
    candidate,
    authority: { kind: "owner-supplied-upgrade" as const, authorizedAt: "2026-08-20T10:00:00.000Z" },
    compatibility: { stateSchema: "lossless-return-proven" as const, evidence: "migration-check-1" },
    verification: { verdict: "passed" as const, evidence: ["artifact-integrity", "state-backup"] },
    review: { verdict: "passed" as const, evidence: ["independent-review-1"] },
    healthCriteria: [
      "exact-identity",
      "artifact-integrity",
      "authoritative-state",
      "write-generation",
      "conversation-context",
      "write-read-probe",
      "recovery-handshake",
    ],
    budget: { deadline: "2026-08-20T10:05:00.000Z", probationChecks: 2 },
    recoveryPath: "restore-exact-baseline-pair" as const,
  };
}

function activationEffects(
  hooks: {
    beforeGenerationTransfer?: () => void;
    healthVerdict?: HealthAssessment["verdict"];
    currentGeneration?: number;
    crashAfterGenerationTransfer?: boolean;
    crashAfterBaselineRestore?: boolean;
    restoredGeneration?: number | undefined;
  },
  observations: string[],
): ActivationEffects {
  const healthy: HealthAssessment = {
    verdict: "healthy",
    subject: "candidate",
    scope: "activation-invariants",
    observedAt: "2026-08-20T10:01:00.000Z",
    evidence: ["all-fixed-criteria-passed"],
  };
  return {
    async verifyCandidate() {
      observations.push("verify-candidate");
    },
    async verifyRecoveryBaseline() {
      return {
        verdict: "healthy",
        subject: "Recovery Baseline",
        scope: "compatibility preflight",
        observedAt: "2026-08-20T09:59:00.000Z",
        evidence: ["exact baseline pair started in isolation"],
      };
    },
    async assessBarrier() {
      observations.push("assess-barrier");
      return { ready: true, blockers: [] };
    },
    async snapshotState() {
      observations.push("snapshot-state");
    },
    async transferWriteGeneration(expected) {
      hooks.beforeGenerationTransfer?.();
      observations.push(`transfer-generation:${expected}`);
      hooks.currentGeneration = expected + 1;
      if (hooks.crashAfterGenerationTransfer) throw new Error("simulated Recovery Actor exit");
      return hooks.currentGeneration;
    },
    async currentWriteGeneration() {
      return hooks.currentGeneration ?? 1;
    },
    async launch(pair, context) {
      observations.push(`launch:${pair.code.revision}:${context.writeGeneration}`);
      return { pid: 42, startedAt: "2026-08-20T10:00:30.000Z", nonce: context.nonce };
    },
    async assessHealth(pair, context) {
      observations.push(`health:${pair.code.revision}:${context.writeGeneration}`);
      return {
        ...healthy,
        verdict: pair.code.revision === candidate.code.revision
          ? hooks.healthVerdict ?? "healthy"
          : "healthy",
      };
    },
    async awaitProbation(pair, context) {
      observations.push(`probation:${pair.code.revision}:${context.writeGeneration}`);
      return healthy;
    },
    async terminate(process) {
      observations.push(`terminate:${process.pid}`);
    },
    async restoreBaseline(pair, failedGeneration) {
      observations.push(`restore:${pair.code.revision}:${failedGeneration}`);
      hooks.currentGeneration = failedGeneration + 1;
      hooks.restoredGeneration = hooks.currentGeneration;
      if (hooks.crashAfterBaselineRestore) {
        throw new Error("simulated exit after baseline restore");
      }
      return hooks.currentGeneration;
    },
    async restoredBaselineGeneration(_pair, failedGeneration) {
      return hooks.restoredGeneration && failedGeneration + 1 === hooks.restoredGeneration
        ? hooks.restoredGeneration
        : undefined;
    },
  };
}
