import assert from "node:assert/strict";
import test from "node:test";

import {
  createLifecycleSelfRepairActivation,
  createSelfRepairController,
  type SelfRepairActivation,
  type SelfRepairCandidateOutcome,
  type SelfRepairRecord,
  type SelfRepairState,
  type SelfRepairWorkerCandidate,
  type SelfRepairWorkerReference,
} from "../src/self-repair-controller/index.ts";
import type { CodeStatePair } from "../src/local-installation/index.ts";
import type { WorkerExecutionAttempt, WorkerSession } from "../src/orchestration-core/index.ts";

const writeRoot = "C:\\repair\\workspace";
const candidateCode = {
  revision: "self-repair-1",
  digest: "a".repeat(64),
  path: "C:\\repair\\workspace\\candidate",
  runtime: { version: "24.17.0", architecture: "x64" },
};

function workerCandidate(): SelfRepairWorkerCandidate {
  return {
    candidateKind: "lead-agent",
    code: { ...candidateCode, runtime: { ...candidateCode.runtime } },
    changedTargets: ["dist/cli.js"],
  };
}

type Harness = {
  state: SelfRepairState & { repairs: Map<string, SelfRepairRecord> };
  controller: ReturnType<typeof createSelfRepairController>;
  delegations: string[];
  activations: string[];
  workerReady(): void;
  activationResult: { outcome: "activated" | "rolled-back"; evidence: string[] };
};

function harness(overrides?: {
  activation?: Partial<SelfRepairActivation>;
}): Harness {
  const repairs = new Map<string, SelfRepairRecord>();
  const workers = new Map<string, WorkerSession>();
  const executions = new Map<string, WorkerExecutionAttempt>();
  const delegations: string[] = [];
  const activations: string[] = [];
  const activationResult = {
    outcome: "activated" as "activated" | "rolled-back",
    evidence: ["tests green on the candidate; rollback available"],
  };
  let currentReference: SelfRepairWorkerReference | undefined;

  const state: Harness["state"] = {
    repairs,
    readCommitment: () => ({ state: "active" }),
    readWorkerSession: (id) => workers.get(id),
    readWorkerExecutionAttempt: (id) => executions.get(id),
    readSelfRepair: (id) => repairs.get(id),
    appendSelfRepairSnapshots: (snapshots) => {
      for (const snapshot of snapshots) repairs.set(snapshot.id, snapshot);
    },
  };

  const makeWorker = (input: {
    selfRepairId: string;
    attemptId: string;
    commitmentId: string;
  }): SelfRepairWorkerReference => {
    const reference: SelfRepairWorkerReference = {
      workerSessionId: `worker-${input.attemptId}`,
      executionAttemptId: `execution-${input.attemptId}`,
      nativeHarness: "codex",
      readOnly: false,
    };
    workers.set(reference.workerSessionId, {
      id: reference.workerSessionId,
      state: "running",
      currentExecutionAttemptId: reference.executionAttemptId,
      assignment: {
        readOnly: false,
        commitmentId: input.commitmentId,
        costBound: { maximumIncrementalSpendUsd: 0 },
        authorizedWriteRoots: [writeRoot],
        authority: { commitmentId: input.commitmentId },
        selfRepair: { selfRepairId: input.selfRepairId, attemptId: input.attemptId },
      },
    } as unknown as WorkerSession);
    executions.set(reference.executionAttemptId, {
      id: reference.executionAttemptId,
      workerSessionId: reference.workerSessionId,
      status: "running",
      modelSelection: { nativeHarness: "codex" },
    } as unknown as WorkerExecutionAttempt);
    currentReference = reference;
    return reference;
  };

  const controller = createSelfRepairController(state, {
    workers: {
      async candidateDelegation() {
        return undefined;
      },
      async delegateCandidate(input) {
        delegations.push(input.attemptId);
        return makeWorker(input);
      },
    },
    preparation: {
      async preparedCandidate() {
        return undefined;
      },
      async prepareCandidate(input): Promise<SelfRepairCandidateOutcome> {
        return {
          candidateKind: "lead-agent",
          candidate: input.candidate.code,
          changedTargets: [...input.candidate.changedTargets],
          verification: {
            verdict: "passed",
            evidence: ["npm test: all suites green on the candidate"],
          },
        };
      },
    },
    activation: {
      async reconcile() {
        return undefined;
      },
      async activate(request) {
        activations.push(request.attemptId);
        return { ...activationResult, evidence: [...activationResult.evidence] };
      },
      ...overrides?.activation,
    },
  });

  return {
    state,
    controller,
    delegations,
    activations,
    activationResult,
    workerReady() {
      const reference = currentReference!;
      const worker = workers.get(reference.workerSessionId)! as unknown as Record<string, unknown>;
      worker.state = "completed";
      worker.outcome = {
        selfRepairCandidate: workerCandidate(),
        affectedArtifacts: ["dist/cli.js"],
        evidence: { providerSessionId: "provider-1", nativeExecutionId: "native-1" },
      };
      const execution = executions.get(reference.executionAttemptId)! as unknown as Record<string, unknown>;
      execution.status = "completed";
      execution.providerSessionId = "provider-1";
      execution.nativeExecutionId = "native-1";
      execution.outcome = {
        evidence: { providerSessionId: "provider-1", nativeExecutionId: "native-1" },
      };
    },
  };
}

function beginInput() {
  return {
    commitmentId: "work-item-1",
    defect: {
      subject: "Lead prompt regression",
      description: "The Lead stopped announcing Workers.",
      evidence: ["transcript excerpt"],
    },
    hypothesis: "The prompt lost its announcement rule.",
    authority: {
      kind: "lead-agent-command-authority" as const,
      authorizedAt: new Date().toISOString(),
      authorizedWriteRoot: writeRoot,
    },
    envelope: {
      maximumAttempts: 2,
      deadline: new Date(Date.now() + 60_000).toISOString(),
      maximumIncrementalSpendUsd: 0,
      allowedEffects: [
        "isolated-filesystem-write" as const,
        "bounded-process-execution" as const,
        "lead-candidate-activation" as const,
      ],
    },
  };
}

test("self-repair runs delegate, verify, activate without a review stage or guardian", async () => {
  const context = harness();
  const repair = context.controller.begin(beginInput());
  assert.equal(repair.version, 2);
  assert.equal(repair.attempts[0]!.status, "candidate-delegation-pending");
  assert.equal(
    "protectedRecoveryActor" in repair.authority,
    false,
    "no guardian identity survives in the durable record",
  );

  let advanced = await context.controller.advance(repair.id);
  assert.equal(advanced.attempts[0]!.status, "candidate-delegated");
  assert.deepEqual(context.delegations, [repair.attempts[0]!.id]);

  // The worker has not completed yet: advancing again neither redelegates nor activates.
  advanced = await context.controller.advance(repair.id);
  assert.equal(advanced.attempts[0]!.status, "candidate-delegated");
  assert.deepEqual(context.delegations, [repair.attempts[0]!.id]);

  context.workerReady();
  advanced = await context.controller.advance(repair.id);
  const attempt = advanced.attempts[0]!;
  assert.equal(attempt.status, "activated");
  assert.equal(attempt.verification?.verdict, "passed");
  assert.deepEqual(context.activations, [attempt.id]);
  assert.match(attempt.activation!.account, /Rollback to the previous version stays one command away/);
});

test("a failed activation records rolled-back and retry demands a changed hypothesis", async () => {
  const context = harness();
  context.activationResult.outcome = "rolled-back";
  context.activationResult.evidence = ["activation failed before cutover"];
  const repair = context.controller.begin(beginInput());
  await context.controller.advance(repair.id);
  context.workerReady();
  const advanced = await context.controller.advance(repair.id);
  assert.equal(advanced.attempts[0]!.status, "rolled-back");

  assert.throws(
    () => context.controller.retry(repair.id, {
      hypothesis: beginInput().hypothesis,
      changedEvidence: ["same idea"],
    }),
    /changed hypothesis/,
  );
  const retried = context.controller.retry(repair.id, {
    hypothesis: "The prompt regression sits in the worker capability section.",
    changedEvidence: ["new diff"],
  });
  assert.equal(retried.attempts.length, 2);
  assert.equal(retried.attempts[1]!.status, "candidate-delegation-pending");
  assert.throws(
    () => context.controller.retry(repair.id, {
      hypothesis: "a third idea",
      changedEvidence: ["more"],
    }),
    /requires a rolled-back or blocked/,
  );
});

test("begin refuses envelopes outside the fixed reversible envelope", () => {
  const context = harness();
  const input = beginInput();
  assert.throws(
    () => context.controller.begin({
      ...input,
      envelope: { ...input.envelope, maximumIncrementalSpendUsd: 5 },
    }),
    /zero-cost/,
  );
  assert.throws(
    () => context.controller.begin({
      ...input,
      envelope: { ...input.envelope, allowedEffects: input.envelope.allowedEffects.slice(0, 2) },
    }),
    /fixed reversible envelope/,
  );
});

test("reconciliation short-circuits activation after a restart", async () => {
  const context = harness({
    activation: {
      async reconcile() {
        return { outcome: "activated", evidence: ["journal already shows the candidate active"] };
      },
    },
  });
  const repair = context.controller.begin(beginInput());
  await context.controller.advance(repair.id);
  context.workerReady();
  const advanced = await context.controller.advance(repair.id);
  assert.equal(advanced.attempts[0]!.status, "activated");
  assert.deepEqual(context.activations, [], "no second cutover after reconciliation");
});

test("lifecycle activation maps upgrade results and failures", async () => {
  const upgrades: string[] = [];
  let inspection: { active?: CodeStatePair } = {};
  let failUpgrade = false;
  const activation = createLifecycleSelfRepairActivation({
    async inspect() {
      return inspection;
    },
    async upgrade(input) {
      upgrades.push(input.leadAgentCandidateDirectory);
      if (failUpgrade) throw new Error("staging rejected the candidate");
      return {
        outcome: "activated",
        active: {
          code: { ...candidateCode },
          state: { revision: "s", digest: "b".repeat(64), snapshotPath: "C:\\snap" },
        },
      };
    },
  });
  const request = {
    selfRepairId: "repair-1",
    attemptId: "attempt-12345678",
    candidate: { ...candidateCode },
  };

  assert.equal(await activation.reconcile(request), undefined);
  inspection = {
    active: {
      code: { ...candidateCode },
      state: { revision: "s", digest: "b".repeat(64), snapshotPath: "C:\\snap" },
    },
  };
  assert.equal((await activation.reconcile(request))?.outcome, "activated");

  const activated = await activation.activate(request);
  assert.equal(activated.outcome, "activated");
  assert.deepEqual(upgrades, [candidateCode.path]);

  failUpgrade = true;
  const failed = await activation.activate(request);
  assert.equal(failed.outcome, "rolled-back");
  assert.match(failed.evidence[0]!, /previously active version keeps running/);
});
