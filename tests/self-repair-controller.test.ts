import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import {
  createOrchestrationCore,
  type WorkerExecutionAttempt,
  type WorkerSession,
} from "../src/orchestration-core/index.ts";
import {
  openRecoveryActor,
  protectedRecoveryPolicyIdentity,
  type ActivationEffects,
  type CodeStatePair,
  type HealthAssessment,
} from "../src/recovery-actor/index.ts";
import {
  createRecoveryActorSelfRepairActivation,
  createSelfRepairController,
  type SelfRepairCandidateOutcome,
  type SelfRepairPreparation,
  type SelfRepairWorkerCandidate,
  type SelfRepairWorkers,
} from "../src/self-repair-controller/index.ts";
import { parseWorkerReportedOutcome } from "../src/worker-supervisor/codex-app-server.ts";

const actorIdentity = {
  revision: "recovery-actor-1",
  digest: "a".repeat(64),
  path: "C:\\Riker\\protected\\recovery-actor-1",
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

test("native Worker outcome parsing preserves the exact Self-repair candidate", () => {
  const candidate = workerCandidate(1);
  const parsed = parseWorkerReportedOutcome(
    `work complete\nCMD_RIKER_OUTCOME:${JSON.stringify({
      status: "completed",
      summary: "Built the isolated candidate.",
      affectedArtifacts: candidate.changedTargets,
      verificationResults: ["Candidate bundle produced for objective host Verification."],
      selfRepairCandidate: candidate,
    })}`,
  );

  assert.equal(parsed.output, "work complete");
  assert.deepEqual(parsed.outcome?.selfRepairCandidate, candidate);
});

test("failed Self-repair rolls back before a changed hypothesis activates a reviewed replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-self-repair-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let state = openAuthoritativeState(join(root, "state"));
  state.initialize(ownerConfiguration(root));
  const ownerTurnId = state.appendOwnerMessage("Repair the controlled reconnect defect.");
  const orchestration = createOrchestrationCore(state);
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The reconnect generation defect is repaired or safely rolled back.",
    criteria: [{ kind: "owner-judgment" }],
  });
  const recovery = openRecoveryActor(
    join(root, "recovery"),
    actorIdentity,
    activationEffects(),
  );
  recovery.initialize({ active: baseline, recoveryBaseline: baseline, writeGeneration: 1 });
  const workers = immediateWorkers(state);
  const preparation = immediatePreparation();
  const actorActivation = createRecoveryActorSelfRepairActivation(recovery);
  let failBeforeStatus: string | undefined;
  const controllerState = {
    readCommitment: (commitmentId: string) => state.readCommitment(commitmentId),
    readWorkerSession: (workerSessionId: string) => state.readWorkerSession(workerSessionId),
    readWorkerExecutionAttempt: (executionAttemptId: string) =>
      state.readWorkerExecutionAttempt(executionAttemptId),
    readSelfRepair: (selfRepairId: string) => state.readSelfRepair(selfRepairId),
    appendSelfRepairSnapshots: (snapshots: Parameters<typeof state.appendSelfRepairSnapshots>[0]) => {
      if (snapshots.at(-1)?.attempts.at(-1)?.status === failBeforeStatus) {
        failBeforeStatus = undefined;
        throw new Error("simulated controller exit before durable transition");
      }
      state.appendSelfRepairSnapshots(snapshots);
    },
  };
  const controller = createSelfRepairController(controllerState, {
    workers,
    preparation,
    protectedRecovery: () => actorActivation.protectedRecovery(),
    reconcile: (request) => actorActivation.reconcile(request),
    async activate(request) {
      const durable = state.readSelfRepair(request.authority.selfRepairId);
      const attempt = durable?.attempts.at(-1);
      assert.equal(attempt?.status, "activation-pending");
      assert.deepEqual(attempt?.candidate, request.candidate);
      assert.deepEqual(attempt?.compatibility, request.compatibility);
      assert.deepEqual(attempt?.verification, request.verification);
      assert.deepEqual(attempt?.review, request.review);
      assert.equal(attempt?.recoveryPath, request.recoveryPath);
      return actorActivation.activate(request);
    },
  });

  const repair = controller.begin({
    commitmentId: commitment.id,
    defect: {
      subject: "Lead Agent reconnect health",
      description: "A controlled reconnect probe returns a stale generation.",
      evidence: ["probe:reconnect-generation-mismatch"],
    },
    hypothesis: "The reconnect adapter does not refresh its generation token.",
    authority: {
      kind: "lead-agent-command-authority",
      authorizedAt: "2026-08-20T12:00:00.000Z",
      authorizedWriteRoot: join(root, "candidate-worktree"),
    },
    envelope: {
      maximumAttempts: 2,
      deadline: "2099-08-20T12:30:00.000Z",
      maximumIncrementalSpendUsd: 0,
      allowedEffects: [
        "isolated-filesystem-write",
        "bounded-process-execution",
        "lead-candidate-activation",
      ],
    },
  });

  const durableBeforeDelegation = state.readSelfRepair(repair.id);
  assert.equal(durableBeforeDelegation?.attempts[0]?.status, "candidate-delegation-pending");
  assert.equal(workers.events.length, 0);
  failBeforeStatus = "candidate-delegated";
  await assert.rejects(controller.advance(repair.id), /simulated controller exit/);
  assert.equal(workers.events.filter((event) => event.kind === "candidate").length, 1);
  workers.forgetVolatileDelegations();
  failBeforeStatus = "rolled-back";
  const activationPending = await controller.advance(repair.id);
  assert.equal(activationPending.attempts[0]?.status, "activation-pending");
  assert.equal(recovery.inspect().currentAttempt?.phase, "rolled-back");
  orchestration.pauseCommitment(commitment.id, ownerTurnId, "Owner paused after cutover completed.");
  await assert.rejects(controller.advance(repair.id), /simulated controller exit/);
  const rolledBack = await controller.advance(repair.id);

  assert.equal(rolledBack.attempts[0]?.status, "rolled-back");
  assert.deepEqual(workers.events.map((event) => event.kind), ["candidate", "review"]);
  assert.notEqual(
    rolledBack.attempts[0]?.implementationWorker?.workerSessionId,
    rolledBack.attempts[0]?.reviewWorker?.workerSessionId,
  );
  const firstAuthority = recovery.inspect().currentAttempt?.authority;
  assert.equal(firstAuthority?.kind, "lead-agent-self-repair");
  assert.equal(
    firstAuthority?.kind === "lead-agent-self-repair" ? firstAuthority.selfRepairId : undefined,
    repair.id,
  );
  assert.equal(
    firstAuthority?.kind === "lead-agent-self-repair"
      ? firstAuthority.recoveryPolicyDigest
      : undefined,
    protectedRecoveryPolicyIdentity.digest,
  );
  assert.equal(recovery.inspect().currentAttempt?.phase, "rolled-back");
  assert.deepEqual(recovery.inspect().active, candidateOutcome(1).baseline);
  assert.deepEqual(recovery.inspect().recoveryBaseline, baseline);
  assert.throws(
    () => controller.retry(repair.id, {
      hypothesis: "The reconnect adapter does not refresh its generation token.",
      changedEvidence: ["probe:failure-reproduced"],
    }),
    /changed hypothesis/i,
  );

  const resumeTurnId = state.appendOwnerMessage("Resume the bounded Self-repair.");
  orchestration.resumeCommitment(commitment.id, resumeTurnId);
  const retry = controller.retry(repair.id, {
    hypothesis: "The token refresh occurs after the reconnect response is emitted.",
    changedEvidence: ["trace:response-precedes-token-refresh"],
  });
  assert.equal(retry.attempts[1]?.status, "candidate-delegation-pending");
  assert.equal(retry.attempts[1]?.previousAttemptId, retry.attempts[0]?.id);
  const secondActivationPending = await controller.advance(repair.id);
  assert.equal(secondActivationPending.attempts[1]?.status, "activation-pending");
  const activated = await controller.advance(repair.id);

  assert.equal(activated.attempts[1]?.status, "activated");
  assert.equal(recovery.inspect().currentAttempt?.authority.kind, "lead-agent-self-repair");
  assert.equal(recovery.inspect().currentAttempt?.phase, "activated");
  assert.equal(recovery.inspect().active?.code.revision, "riker-repair-2");
  assert.deepEqual(recovery.inspect().recoveryBaseline, baseline);
  assert.equal(activated.attempts[1]?.budget.attemptNumber, 2);
  assert.equal(activated.attempts[1]?.compatibility?.stateSchema, "lossless-return-proven");
  assert.equal(activated.attempts[1]?.verification?.verdict, "passed");
  assert.equal(activated.attempts[1]?.review?.verdict, "passed");
  assert.equal(activated.attempts[1]?.recoveryPath, "restore-exact-baseline-pair");
  assert.match(activated.attempts[1]?.activation?.account ?? "", /Recovery Baseline promotion remains a later decision/);
  assert.equal(activated.attempts[1]?.budget.maximumIncrementalSpendUsd, 0);
  assert.deepEqual(activated.attempts[1]?.budget.allowedEffects, [
    "isolated-filesystem-write",
    "bounded-process-execution",
    "lead-candidate-activation",
  ]);

  const reportTurnId = state.appendOwnerMessage("Report the completed Self-repair attempts.");
  const deliveredAt = "2026-08-20T12:20:00.000Z";
  const deliveredRepair = {
    ...activated,
    attempts: activated.attempts.map((attempt) => ({
      ...attempt,
      ...(attempt.activation
        ? { activation: { ...attempt.activation, deliveredAt } }
        : {}),
    })),
  };
  const account = activated.attempts.map((attempt) => attempt.activation?.account).join("\n");
  state.appendLeadAgentMessageWithAccounts(
    reportTurnId,
    account,
    { selfRepairs: [deliveredRepair], commitments: [] },
  );
  assert.match(state.leadAgentResponse(reportTurnId) ?? "", /rolled back before another attempt/);
  assert.match(state.leadAgentResponse(reportTurnId) ?? "", /Recovery Baseline promotion remains a later decision/);

  state.close();
  state = openAuthoritativeState(join(root, "state"));
  const restored = state.readSelfRepair(repair.id);
  assert.equal(restored?.attempts.length, 2);
  assert.equal(restored?.attempts[0]?.status, "rolled-back");
  assert.equal(restored?.attempts[1]?.status, "activated");
  assert.equal(restored?.attempts.every((attempt) => Boolean(attempt.activation?.deliveredAt)), true);
  assert.equal(restored?.authority.protectedRecoveryActor.revision, actorIdentity.revision);
  state.close();
  recovery.close();
});

function immediateWorkers(state: ReturnType<typeof openAuthoritativeState>): SelfRepairWorkers & {
  events: Array<{ kind: "candidate" | "review"; attemptNumber: number }>;
  forgetVolatileDelegations(): void;
} {
  const events: Array<{ kind: "candidate" | "review"; attemptNumber: number }> = [];
  const candidateDelegations = new Map<string, Awaited<ReturnType<SelfRepairWorkers["delegateCandidate"]>>>();
  const reviewDelegations = new Map<string, Awaited<ReturnType<SelfRepairWorkers["delegateReview"]>>>();
  return {
    events,
    forgetVolatileDelegations() {
      candidateDelegations.clear();
      reviewDelegations.clear();
    },
    async candidateDelegation(attemptId) {
      return candidateDelegations.get(attemptId) ?? durableDelegation(state, attemptId, false);
    },
    async delegateCandidate(input) {
      events.push({ kind: "candidate", attemptNumber: input.attemptNumber });
      const workerSessionId = `implementation-${input.attemptNumber}`;
      const outcome = workerCandidate(input.attemptNumber);
      const delegation = {
        workerSessionId,
        executionAttemptId: `implementation-execution-${input.attemptNumber}`,
        nativeHarness: "codex" as const,
        readOnly: false,
      };
      candidateDelegations.set(input.attemptId, delegation);
      recordWorker(state, {
        reference: delegation,
        selfRepairId: input.selfRepairId,
        attemptId: input.attemptId,
        commitmentId: input.commitmentId,
        targetProjectPath: input.authorizedWriteRoot,
        objective: "Produce an immutable Self-repair candidate.",
        readOnly: false,
        verificationResults: ["Candidate bundle produced for objective host Verification."],
        candidate: outcome,
      });
      return delegation;
    },
    async reviewDelegation(attemptId) {
      return reviewDelegations.get(attemptId) ?? durableDelegation(state, attemptId, true);
    },
    async delegateReview(input) {
      events.push({ kind: "review", attemptNumber: input.attemptNumber });
      const delegation = {
        workerSessionId: `review-${input.attemptNumber}`,
        executionAttemptId: `review-execution-${input.attemptNumber}`,
        nativeHarness: "claude" as const,
        readOnly: true,
      };
      reviewDelegations.set(input.attemptId, delegation);
      recordWorker(state, {
        reference: delegation,
        selfRepairId: input.selfRepairId,
        attemptId: input.attemptId,
        commitmentId: input.commitmentId,
        targetProjectPath: input.candidate.code.path,
        objective: "Independently review the Self-repair candidate.",
        readOnly: true,
        verificationResults: ["independent-review:no-material-findings"],
        implementationWorkerSessionId: input.implementationWorker.workerSessionId,
      });
      return delegation;
    },
  };
}

function durableDelegation(
  state: ReturnType<typeof openAuthoritativeState>,
  attemptId: string,
  readOnly: boolean,
): Awaited<ReturnType<SelfRepairWorkers["delegateCandidate"]>> | undefined {
  const worker = state.readWorkerSessions().find(
    (candidate) =>
      candidate.assignment.selfRepair?.attemptId === attemptId &&
      candidate.assignment.readOnly === readOnly,
  );
  const execution = worker
    ? state.readWorkerExecutionAttempt(worker.currentExecutionAttemptId)
    : undefined;
  return worker && execution
    ? {
        workerSessionId: worker.id,
        executionAttemptId: execution.id,
        nativeHarness: execution.modelSelection.nativeHarness,
        readOnly,
      }
    : undefined;
}

function recordWorker(
  state: ReturnType<typeof openAuthoritativeState>,
  input: {
    reference: Awaited<ReturnType<SelfRepairWorkers["delegateCandidate"]>>;
    selfRepairId: string;
    attemptId: string;
    commitmentId: string;
    targetProjectPath: string;
    objective: string;
    readOnly: boolean;
    verificationResults: string[];
    candidate?: SelfRepairWorkerCandidate;
    implementationWorkerSessionId?: string;
  },
): void {
  const assignmentBase = {
    objective: input.objective,
    prompt: input.objective,
    targetProjectPath: input.targetProjectPath,
    modelPolicyRevision: "self-repair-worker-policy-1",
    commitmentId: input.commitmentId,
    selfRepair: { selfRepairId: input.selfRepairId, attemptId: input.attemptId },
  };
  const assignment: WorkerSession["assignment"] = input.readOnly
    ? {
        ...assignmentBase,
        readOnly: true,
        coordination: {
          role: "reviewer",
          reviewOfWorkerSessionId: input.implementationWorkerSessionId!,
        },
      }
    : {
        ...assignmentBase,
        readOnly: false,
        targets: ["src/local-host/index.ts"],
        effectClasses: ["filesystem-write", "bounded-process-execution"],
        authorizedWriteRoots: [input.targetProjectPath],
        timeoutMs: 60_000,
        costBound: { maximumIncrementalSpendUsd: 0 },
        checkoutIsolation: {
          root: input.targetProjectPath,
          baselineCommit: "a".repeat(40),
          isolation: { kind: "branch", branch: `self-repair/${input.attemptId}` },
        },
        authority: {
          kind: "lead-agent-command-authority",
          commitmentId: input.commitmentId,
          validatedAt: "2026-08-20T12:00:00.000Z",
        },
        recoveryConstraint: "reconcile-before-replay",
        verification: {
          operation: "test",
          workingDirectory: input.targetProjectPath,
          timeoutMs: 30_000,
        },
        coordination: { role: "implementer" },
      };
  const worker: WorkerSession = {
    id: input.reference.workerSessionId,
    assignment,
    state: "completed",
    currentExecutionAttemptId: input.reference.executionAttemptId,
    outcome: {
      status: "completed",
      summary: input.objective,
      affectedArtifacts: input.readOnly ? [] : ["src/local-host/index.ts"],
      materialCommands: [],
      verificationResults: input.verificationResults,
      ...(input.readOnly ? { reviewFindings: [] } : {}),
      ...(input.candidate ? { selfRepairCandidate: input.candidate } : {}),
      evidence: {
        providerSessionId: `${input.reference.workerSessionId}-provider`,
        nativeExecutionId: `${input.reference.executionAttemptId}-native`,
        harnessVersion: `${input.reference.nativeHarness}-test`,
      },
    },
  };
  const execution: WorkerExecutionAttempt = {
    id: input.reference.executionAttemptId,
    workerSessionId: input.reference.workerSessionId,
    generation: 1,
    modelSelection: input.reference.nativeHarness === "claude"
      ? { provider: "anthropic", model: "claude-sonnet-5", nativeHarness: "claude" }
      : { provider: "openai", model: "gpt-5.6-sol", nativeHarness: "codex" },
    modelPolicyRevision: "self-repair-worker-policy-1",
    status: "completed",
    providerSessionId: `${input.reference.workerSessionId}-provider`,
    nativeExecutionId: `${input.reference.executionAttemptId}-native`,
    outcome: worker.outcome!,
  };
  state.appendWorkerSessionSnapshots([worker]);
  state.appendWorkerExecutionAttemptSnapshots([execution]);
}

function candidateOutcome(attemptNumber: number): SelfRepairCandidateOutcome {
  return {
    candidateKind: "lead-agent",
    candidate: {
      code: {
        revision: `riker-repair-${attemptNumber}`,
        digest: String(attemptNumber + 3).repeat(64),
        path: `C:\\Riker\\versions\\riker-repair-${attemptNumber}`,
        runtime: { version: "24.17.0", architecture: "x64" },
      },
      state: {
        revision: `state-repair-${attemptNumber}`,
        digest: String(attemptNumber + 5).repeat(64),
        snapshotPath: `C:\\Riker\\recovery\\state-repair-${attemptNumber}.sqlite`,
      },
    },
    baseline: {
      code: baseline.code,
      state: {
        revision: `state-repair-${attemptNumber}`,
        digest: String(attemptNumber + 5).repeat(64),
        snapshotPath: `C:\\Riker\\recovery\\state-repair-${attemptNumber}.sqlite`,
      },
    },
    changedTargets: ["src/local-host/index.ts"],
    compatibility: {
      stateSchema: "lossless-return-proven",
      evidence: `snapshot-roundtrip-${attemptNumber}`,
    },
    verification: {
      verdict: "passed",
      evidence: [`focused-reconnect-test-${attemptNumber}`, "full-test-suite"],
    },
    recoveryPath: "restore-exact-baseline-pair",
  };
}

function workerCandidate(attemptNumber: number): SelfRepairWorkerCandidate {
  const prepared = candidateOutcome(attemptNumber);
  return {
    candidateKind: "lead-agent",
    code: prepared.candidate.code,
    changedTargets: prepared.changedTargets,
  };
}

function immediatePreparation(): SelfRepairPreparation {
  const prepared = new Map<string, SelfRepairCandidateOutcome>();
  return {
    async preparedCandidate(attemptId) {
      return prepared.get(attemptId);
    },
    async prepareCandidate(input) {
      const attemptNumber = Number(input.candidate.code.revision.split("-").at(-1));
      const outcome = candidateOutcome(attemptNumber);
      prepared.set(input.attemptId, outcome);
      return outcome;
    },
  };
}

function activationEffects(): ActivationEffects {
  let generation = 1;
  const healthy: HealthAssessment = {
    verdict: "healthy",
    subject: "candidate",
    scope: "activation-invariants",
    observedAt: "2026-08-20T12:05:00.000Z",
    evidence: ["all-fixed-criteria-passed"],
  };
  return {
    async verifyCandidate() {},
    async verifyRecoveryBaseline() {
      return { ...healthy, subject: "Recovery Baseline", scope: "compatibility-preflight" };
    },
    async assessBarrier() {
      return { ready: true, blockers: [] };
    },
    async snapshotState() {},
    async transferWriteGeneration(expected) {
      generation = expected + 1;
      return generation;
    },
    async currentWriteGeneration() {
      return generation;
    },
    async launch(_pair, context) {
      return { pid: 42, startedAt: "2026-08-20T12:04:00.000Z", nonce: context.nonce };
    },
    async assessHealth(pair) {
      return {
        ...healthy,
        verdict: pair.code.revision === "riker-repair-1" ? "impaired" : "healthy",
      };
    },
    async awaitProbation() {
      return healthy;
    },
    async terminate() {},
    async restoreBaseline(_pair, failedGeneration) {
      generation = failedGeneration + 1;
      return generation;
    },
    async restoredBaselineGeneration() {
      return undefined;
    },
  };
}

function ownerConfiguration(root: string) {
  return {
    targetProject: { path: join(root, "target-project") },
    modelSelection: {
      provider: "local-openai" as const,
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "lead-policy-1",
  };
}
