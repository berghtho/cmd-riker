import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type { CodeStatePair } from "../local-installation/index.ts";
import type { WorkerExecutionAttempt, WorkerSession } from "../orchestration-core/index.ts";

type AllowedSelfRepairEffect =
  | "isolated-filesystem-write"
  | "bounded-process-execution"
  | "lead-candidate-activation";

export type SelfRepairWorkerReference = {
  workerSessionId: string;
  executionAttemptId: string;
  nativeHarness: "codex" | "claude" | "copilot";
  readOnly: boolean;
};

export type SelfRepairWorkerCandidate = {
  candidateKind: "lead-agent";
  code: CodeStatePair["code"];
  changedTargets: string[];
};

export type SelfRepairCandidateOutcome = {
  candidateKind: "lead-agent";
  candidate: SelfRepairWorkerCandidate["code"];
  changedTargets: string[];
  // Verification is green tests on the candidate; rollback stays available
  // through the versioned install the activation records.
  verification: { verdict: "passed"; evidence: string[] };
};

export type SelfRepairAttempt = {
  id: string;
  previousAttemptId?: string;
  hypothesis: string;
  changedEvidence: string[];
  status:
    | "candidate-delegation-pending"
    | "candidate-delegated"
    | "activation-pending"
    | "activated"
    | "rolled-back"
    | "blocked";
  budget: {
    attemptNumber: number;
    maximumAttempts: number;
    deadline: string;
    maximumIncrementalSpendUsd: number;
    allowedEffects: AllowedSelfRepairEffect[];
  };
  implementationWorker?: SelfRepairWorkerReference;
  candidate?: SelfRepairWorkerCandidate["code"];
  changedTargets?: string[];
  verification?: SelfRepairCandidateOutcome["verification"];
  activation?: {
    outcome: "activated" | "rolled-back";
    evidence: string[];
    observedAt: string;
    account: string;
    deliveredAt?: string;
  };
};

export type SelfRepairRecord = {
  version: 2;
  id: string;
  commitmentId: string;
  defect: {
    subject: string;
    description: string;
    evidence: string[];
    diagnosedAt: string;
  };
  authority: {
    kind: "lead-agent-command-authority";
    authorizedAt: string;
    authorizedWriteRoot: string;
  };
  envelope: {
    maximumAttempts: number;
    deadline: string;
    maximumIncrementalSpendUsd: number;
    allowedEffects: AllowedSelfRepairEffect[];
  };
  attempts: SelfRepairAttempt[];
};

export interface SelfRepairState {
  readCommitment(commitmentId: string): { state: string } | undefined;
  readWorkerSession(workerSessionId: string): WorkerSession | undefined;
  readWorkerExecutionAttempt(executionAttemptId: string): WorkerExecutionAttempt | undefined;
  readSelfRepair(selfRepairId: string): SelfRepairRecord | undefined;
  appendSelfRepairSnapshots(snapshots: SelfRepairRecord[]): void;
}

export interface SelfRepairWorkers {
  // Lookups are durable and keyed by repair attempt so restart never redispatches native work.
  candidateDelegation(attemptId: string): Promise<SelfRepairWorkerReference | undefined>;
  delegateCandidate(input: {
    selfRepairId: string;
    attemptId: string;
    attemptNumber: number;
    commitmentId: string;
    defect: SelfRepairRecord["defect"];
    hypothesis: string;
    authorizedWriteRoot: string;
    budget: SelfRepairAttempt["budget"];
  }): Promise<SelfRepairWorkerReference>;
}

export interface SelfRepairPreparation {
  preparedCandidate(attemptId: string): Promise<SelfRepairCandidateOutcome | undefined>;
  prepareCandidate(input: {
    selfRepairId: string;
    attemptId: string;
    candidate: SelfRepairWorkerCandidate;
  }): Promise<SelfRepairCandidateOutcome>;
}

export type SelfRepairActivationRequest = {
  selfRepairId: string;
  attemptId: string;
  candidate: SelfRepairWorkerCandidate["code"];
};

export interface SelfRepairActivation {
  // Reconciliation answers whether this attempt's candidate already cut over,
  // so restart never re-activates.
  reconcile(request: SelfRepairActivationRequest): Promise<{
    outcome: "activated" | "rolled-back";
    evidence: string[];
  } | undefined>;
  activate(request: SelfRepairActivationRequest): Promise<{
    outcome: "activated" | "rolled-back";
    evidence: string[];
  }>;
}

export interface SelfRepairController {
  begin(input: {
    commitmentId: string;
    defect: { subject: string; description: string; evidence: string[] };
    hypothesis: string;
    authority: SelfRepairRecord["authority"];
    envelope: SelfRepairRecord["envelope"];
  }): SelfRepairRecord;
  advance(selfRepairId: string): Promise<SelfRepairRecord>;
  retry(
    selfRepairId: string,
    input: { hypothesis: string; changedEvidence: string[] },
  ): SelfRepairRecord;
  view(selfRepairId: string): SelfRepairRecord | undefined;
}

export function createSelfRepairController(
  state: SelfRepairState,
  dependencies: {
    workers: SelfRepairWorkers;
    preparation: SelfRepairPreparation;
    activation: SelfRepairActivation;
  },
): SelfRepairController {
  const appendAttempt = (
    repair: SelfRepairRecord,
    attempt: SelfRepairAttempt,
  ): SelfRepairRecord => {
    const updated = {
      ...repair,
      attempts: repair.attempts.map((candidate) => candidate.id === attempt.id ? attempt : candidate),
    };
    state.appendSelfRepairSnapshots([updated]);
    return updated;
  };

  return {
    begin(input) {
      validateBeginInput(input);
      const commitment = state.readCommitment(input.commitmentId);
      if (!commitment || commitment.state !== "active") {
        throw new Error("Self-repair requires one active Work Item.");
      }
      const repair: SelfRepairRecord = {
        version: 2,
        id: randomUUID(),
        commitmentId: input.commitmentId,
        defect: {
          ...input.defect,
          evidence: [...input.defect.evidence],
          diagnosedAt: new Date().toISOString(),
        },
        authority: {
          ...input.authority,
          authorizedWriteRoot: resolve(input.authority.authorizedWriteRoot),
        },
        envelope: {
          ...input.envelope,
          allowedEffects: [...input.envelope.allowedEffects],
        },
        attempts: [newAttempt(input.hypothesis, [], input.envelope, 1)],
      };
      state.appendSelfRepairSnapshots([repair]);
      return repair;
    },

    async advance(selfRepairId) {
      let repair = requireRepair(state, selfRepairId);
      while (true) {
        const attempt = repair.attempts.at(-1)!;
        if (["activated", "rolled-back", "blocked"].includes(attempt.status)) return repair;
        if (attempt.status !== "activation-pending") {
          requireActiveCommitment(state, repair.commitmentId);
          assertWithinDeadline(attempt);
        }
        switch (attempt.status) {
          case "candidate-delegation-pending": {
            const implementationWorker =
              await dependencies.workers.candidateDelegation(attempt.id) ??
              await dependencies.workers.delegateCandidate({
                selfRepairId: repair.id,
                attemptId: attempt.id,
                attemptNumber: attempt.budget.attemptNumber,
                commitmentId: repair.commitmentId,
                defect: repair.defect,
                hypothesis: attempt.hypothesis,
                authorizedWriteRoot: repair.authority.authorizedWriteRoot,
                budget: attempt.budget,
              });
            validateWorkerReference(implementationWorker);
            validateDurableWorker(state, repair, attempt, implementationWorker, false);
            repair = appendAttempt(repair, {
              ...attempt,
              status: "candidate-delegated",
              implementationWorker,
            });
            continue;
          }
          case "candidate-delegated": {
            const pendingWorker = validateDurableWorker(
              state,
              repair,
              attempt,
              attempt.implementationWorker!,
              false,
            );
            if (pendingWorker.worker.state !== "completed" || pendingWorker.execution.status !== "completed") {
              return repair;
            }
            const workerEvidence = validateDurableWorker(
              state,
              repair,
              attempt,
              attempt.implementationWorker!,
              true,
            );
            const workerCandidate = workerEvidence.worker.outcome?.selfRepairCandidate;
            if (!workerCandidate) {
              throw new Error("The implementing Worker did not durably report a Self-repair candidate.");
            }
            validateWorkerCandidate(workerCandidate, repair, workerEvidence.worker);
            const outcome =
              await dependencies.preparation.preparedCandidate(attempt.id) ??
              await dependencies.preparation.prepareCandidate({
                selfRepairId: repair.id,
                attemptId: attempt.id,
                candidate: workerCandidate,
              });
            validateCandidateOutcome(outcome, workerCandidate);
            repair = appendAttempt(repair, {
              ...attempt,
              status: "activation-pending",
              candidate: outcome.candidate,
              changedTargets: [...outcome.changedTargets],
              verification: outcome.verification,
            });
            continue;
          }
          case "activation-pending": {
            const request: SelfRepairActivationRequest = {
              selfRepairId: repair.id,
              attemptId: attempt.id,
              candidate: attempt.candidate!,
            };
            let result = await dependencies.activation.reconcile(request);
            if (!result) {
              requireActiveCommitment(state, repair.commitmentId);
              assertWithinDeadline(attempt);
              result = await dependencies.activation.activate(request);
            }
            validateEvidence(result.evidence, "Self-repair activation");
            const observedAt = new Date().toISOString();
            return appendAttempt(repair, {
              ...attempt,
              status: result.outcome,
              activation: {
                outcome: result.outcome,
                evidence: result.evidence,
                observedAt,
                account: result.outcome === "activated"
                  ? `Self-repair activated revision ${attempt.candidate!.revision} for ${repair.defect.subject}. ` +
                    `Evidence: ${result.evidence.join("; ")}. Effects: ${attempt.changedTargets!.join(", ")}. ` +
                    "Rollback to the previous version stays one command away."
                  : `Self-repair revision ${attempt.candidate!.revision} for ${repair.defect.subject} ` +
                    `did not activate under hypothesis ${attempt.hypothesis}. ` +
                    `Evidence: ${result.evidence.join("; ")}. ` +
                    "Residual uncertainty: the diagnosed defect remains unresolved.",
              },
            });
          }
        }
      }
    },

    retry(selfRepairId, input) {
      const repair = requireRepair(state, selfRepairId);
      const previous = repair.attempts.at(-1)!;
      if (previous.status !== "rolled-back" && previous.status !== "blocked") {
        throw new Error("Self-repair retry requires a rolled-back or blocked previous attempt.");
      }
      if (!input.hypothesis.trim() || input.hypothesis.trim() === previous.hypothesis.trim()) {
        throw new Error("Every Self-repair retry requires a changed hypothesis.");
      }
      validateEvidence(input.changedEvidence, "Changed Self-repair evidence");
      const attemptNumber = previous.budget.attemptNumber + 1;
      if (attemptNumber > repair.envelope.maximumAttempts) {
        throw new Error("Self-repair attempt budget is exhausted.");
      }
      assertWithinDeadline(previous);
      const attempt = {
        ...newAttempt(input.hypothesis, input.changedEvidence, repair.envelope, attemptNumber),
        previousAttemptId: previous.id,
      };
      const updated = { ...repair, attempts: [...repair.attempts, attempt] };
      state.appendSelfRepairSnapshots([updated]);
      return updated;
    },

    view(selfRepairId) {
      return state.readSelfRepair(selfRepairId);
    },
  };
}

function newAttempt(
  hypothesis: string,
  changedEvidence: string[],
  envelope: SelfRepairRecord["envelope"],
  attemptNumber: number,
): SelfRepairAttempt {
  return {
    id: randomUUID(),
    hypothesis: hypothesis.trim(),
    changedEvidence: [...changedEvidence],
    status: "candidate-delegation-pending",
    budget: {
      attemptNumber,
      maximumAttempts: envelope.maximumAttempts,
      deadline: envelope.deadline,
      maximumIncrementalSpendUsd: envelope.maximumIncrementalSpendUsd,
      allowedEffects: [...envelope.allowedEffects],
    },
  };
}

function validateBeginInput(input: Parameters<SelfRepairController["begin"]>[0]): void {
  if (
    !input.commitmentId.trim() ||
    !input.defect.subject.trim() ||
    !input.defect.description.trim() ||
    !input.hypothesis.trim()
  ) {
    throw new Error("Self-repair requires a Work Item, concrete defect, and repair hypothesis.");
  }
  validateEvidence(input.defect.evidence, "Self-repair diagnosis");
  if (
    input.authority.kind !== "lead-agent-command-authority" ||
    !input.authority.authorizedWriteRoot.trim() ||
    !Number.isFinite(Date.parse(input.authority.authorizedAt))
  ) {
    throw new Error("Self-repair requires exact Command Authority.");
  }
  if (
    !Number.isSafeInteger(input.envelope.maximumAttempts) ||
    input.envelope.maximumAttempts < 1 ||
    input.envelope.maximumIncrementalSpendUsd !== 0 ||
    !Number.isFinite(Date.parse(input.envelope.deadline)) ||
    Date.parse(input.envelope.deadline) <= Date.now()
  ) {
    throw new Error("Self-repair requires a live, zero-cost, bounded attempt envelope.");
  }
  const effects = new Set(input.envelope.allowedEffects);
  if (
    effects.size !== 3 ||
    !effects.has("isolated-filesystem-write") ||
    !effects.has("bounded-process-execution") ||
    !effects.has("lead-candidate-activation")
  ) {
    throw new Error("Self-repair effects must stay inside the fixed reversible envelope.");
  }
}

function validateWorkerCandidate(
  outcome: SelfRepairWorkerCandidate,
  repair: SelfRepairRecord,
  worker: WorkerSession,
): void {
  if (
    outcome.candidateKind !== "lead-agent" ||
    !outcome.code.revision.trim() ||
    !isDigest(outcome.code.digest) ||
    !outcome.code.path.trim()
  ) {
    throw new Error("A Self-repair candidate must be an exact immutable Lead Agent bundle.");
  }
  if (
    outcome.changedTargets.length === 0 ||
    outcome.changedTargets.some(
      (target) =>
        !target.trim() ||
        isAbsolute(target) ||
        !isWithin(repair.authority.authorizedWriteRoot, resolve(repair.authority.authorizedWriteRoot, target)),
    )
  ) {
    throw new Error("A Self-repair candidate must identify its changed targets.");
  }
  if (
    !worker.outcome ||
    JSON.stringify(worker.outcome.affectedArtifacts) !== JSON.stringify(outcome.changedTargets)
  ) {
    throw new Error("Self-repair candidate evidence must match the durable Worker outcome.");
  }
  const assignment = worker.assignment;
  if (
    assignment.readOnly ||
    assignment.costBound.maximumIncrementalSpendUsd !== repair.envelope.maximumIncrementalSpendUsd ||
    assignment.authorizedWriteRoots.length !== 1 ||
    !samePath(assignment.authorizedWriteRoots[0]!, repair.authority.authorizedWriteRoot) ||
    assignment.authority.commitmentId !== repair.commitmentId
  ) {
    throw new Error("Self-repair candidate work exceeded its durable authority or effect envelope.");
  }
}

function validateCandidateOutcome(
  outcome: SelfRepairCandidateOutcome,
  workerCandidate: SelfRepairWorkerCandidate,
): void {
  if (
    JSON.stringify(outcome.candidate) !== JSON.stringify(workerCandidate.code) ||
    JSON.stringify(outcome.changedTargets) !== JSON.stringify(workerCandidate.changedTargets)
  ) {
    throw new Error("Prepared Self-repair evidence does not match the implementing Worker candidate.");
  }
  if (outcome.verification.verdict !== "passed") {
    throw new Error("Self-repair candidate Verification must pass before activation.");
  }
  validateEvidence(outcome.verification.evidence, "Self-repair Verification");
}

function validateWorkerReference(worker: SelfRepairWorkerReference): void {
  if (
    !worker.workerSessionId.trim() ||
    !worker.executionAttemptId.trim() ||
    worker.readOnly !== false
  ) {
    throw new Error("Self-repair delegation requires exact Worker Session and execution identities.");
  }
}

function validateDurableWorker(
  state: SelfRepairState,
  repair: SelfRepairRecord,
  attempt: SelfRepairAttempt,
  reference: SelfRepairWorkerReference,
  requireCompleted: boolean,
): { worker: WorkerSession; execution: WorkerExecutionAttempt } {
  const worker = state.readWorkerSession(reference.workerSessionId);
  const execution = state.readWorkerExecutionAttempt(reference.executionAttemptId);
  if (
    !worker ||
    !execution ||
    worker.currentExecutionAttemptId !== reference.executionAttemptId ||
    execution.workerSessionId !== reference.workerSessionId ||
    execution.modelSelection.nativeHarness !== reference.nativeHarness ||
    worker.assignment.readOnly !== false ||
    worker.assignment.commitmentId !== repair.commitmentId ||
    worker.assignment.selfRepair?.selfRepairId !== repair.id ||
    worker.assignment.selfRepair.attemptId !== attempt.id
  ) {
    throw new Error("Self-repair evidence requires one exact durable native Worker execution.");
  }
  if (requireCompleted && (worker.state !== "completed" || execution.status !== "completed")) {
    throw new Error("Self-repair evidence requires a completed current Worker execution.");
  }
  if (
    requireCompleted &&
    (!worker.outcome?.evidence.providerSessionId ||
      !worker.outcome.evidence.nativeExecutionId ||
      execution.providerSessionId !== worker.outcome.evidence.providerSessionId ||
      execution.nativeExecutionId !== worker.outcome.evidence.nativeExecutionId ||
      execution.outcome?.evidence.providerSessionId !== worker.outcome.evidence.providerSessionId ||
      execution.outcome.evidence.nativeExecutionId !== worker.outcome.evidence.nativeExecutionId)
  ) {
    throw new Error("Self-repair evidence requires exact native Provider Session and execution identity.");
  }
  return { worker, execution };
}

function validateEvidence(evidence: string[], subject: string): void {
  if (evidence.length === 0 || evidence.some((item) => !item.trim())) {
    throw new Error(`${subject} requires concrete evidence.`);
  }
}

function requireRepair(state: SelfRepairState, selfRepairId: string): SelfRepairRecord {
  const repair = state.readSelfRepair(selfRepairId);
  if (!repair) throw new Error(`Unknown Self-repair ${selfRepairId}.`);
  return repair;
}

function requireActiveCommitment(state: SelfRepairState, commitmentId: string): void {
  if (state.readCommitment(commitmentId)?.state !== "active") {
    throw new Error("Self-repair effects stop while their Work Item is not active.");
  }
}

function assertWithinDeadline(attempt: SelfRepairAttempt): void {
  if (Date.parse(attempt.budget.deadline) <= Date.now()) {
    throw new Error("Self-repair time budget is exhausted.");
  }
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

// Activation through Lifecycle v2: the upgrade records the previous version, so
// rollback stays one command away; reconciliation reads the lifecycle journal.
export function createLifecycleSelfRepairActivation(installation: {
  inspect(): Promise<{ active?: CodeStatePair; previous?: CodeStatePair }>;
  upgrade(input: {
    leadAgentCandidateDirectory: string;
    stateRevision: string;
    stateProvenance: string;
  }): Promise<{ outcome: "activated"; active: CodeStatePair }>;
}): SelfRepairActivation {
  return {
    async reconcile(request) {
      const inspection = await installation.inspect();
      if (
        inspection.active?.code.revision === request.candidate.revision &&
        inspection.active.code.digest === request.candidate.digest
      ) {
        return {
          outcome: "activated",
          evidence: ["The lifecycle journal shows the Self-repair candidate is active."],
        };
      }
      return undefined;
    },
    async activate(request) {
      try {
        const result = await installation.upgrade({
          leadAgentCandidateDirectory: request.candidate.path,
          stateRevision: `self-repair-${request.attemptId.slice(0, 8)}`,
          stateProvenance: `Self-repair ${request.selfRepairId}`,
        });
        return {
          outcome: "activated",
          evidence: [
            `Activated revision ${result.active.code.revision}; the previous version remains available for rollback.`,
          ],
        };
      } catch (error) {
        return {
          outcome: "rolled-back",
          evidence: [
            `Activation failed before cutover: ${error instanceof Error ? error.message : String(error)}. ` +
              "The previously active version keeps running.",
          ],
        };
      }
    },
  };
}
