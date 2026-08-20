import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import {
  requiredActivationHealthCriteria,
  protectedRecoveryPolicyIdentity,
  type ActivationAttempt,
  type CodeStatePair,
  type RecoveryActor,
  type RecoveryActorIdentity,
  type RecoveryPolicyIdentity,
} from "../recovery-actor/index.ts";
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
  candidate: CodeStatePair;
  changedTargets: string[];
  baseline: CodeStatePair;
  compatibility: { stateSchema: "lossless-return-proven"; evidence: string };
  verification: { verdict: "passed"; evidence: string[] };
  recoveryPath: "restore-exact-baseline-pair";
};

export type SelfRepairReviewOutcome = {
  verdict: "passed" | "changes-requested";
  evidence: string[];
};

export type SelfRepairAttempt = {
  id: string;
  previousAttemptId?: string;
  hypothesis: string;
  changedEvidence: string[];
  status:
    | "candidate-delegation-pending"
    | "candidate-delegated"
    | "review-delegation-pending"
    | "review-delegated"
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
  candidate?: CodeStatePair;
  baseline?: CodeStatePair;
  changedTargets?: string[];
  compatibility?: SelfRepairCandidateOutcome["compatibility"];
  verification?: SelfRepairCandidateOutcome["verification"];
  reviewWorker?: SelfRepairWorkerReference;
  review?: SelfRepairReviewOutcome;
  recoveryPath?: SelfRepairCandidateOutcome["recoveryPath"];
  activation?: {
    attemptId: string;
    outcome: "activated" | "rolled-back";
    evidence: string[];
    observedAt: string;
    account: string;
    deliveredAt?: string;
  };
};

export type SelfRepairRecord = {
  version: 1;
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
    protectedRecoveryActor: RecoveryActorIdentity;
    protectedRecoveryPolicy: RecoveryPolicyIdentity;
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
    protectedRecoveryActor: RecoveryActorIdentity;
    budget: SelfRepairAttempt["budget"];
  }): Promise<SelfRepairWorkerReference>;
  reviewDelegation(attemptId: string): Promise<SelfRepairWorkerReference | undefined>;
  delegateReview(input: {
    selfRepairId: string;
    attemptId: string;
    attemptNumber: number;
    commitmentId: string;
    implementationWorker: SelfRepairWorkerReference;
    candidate: CodeStatePair;
    verification: SelfRepairCandidateOutcome["verification"];
  }): Promise<SelfRepairWorkerReference>;
}

export interface SelfRepairPreparation {
  preparedCandidate(attemptId: string): Promise<SelfRepairCandidateOutcome | undefined>;
  prepareCandidate(input: {
    selfRepairId: string;
    attemptId: string;
    candidate: SelfRepairWorkerCandidate;
    protectedRecoveryActor: RecoveryActorIdentity;
  }): Promise<SelfRepairCandidateOutcome>;
}

export type SelfRepairActivationRequest = Pick<
  ActivationAttempt,
  | "baseline"
  | "candidate"
  | "compatibility"
  | "verification"
  | "review"
  | "healthCriteria"
  | "budget"
  | "recoveryPath"
> & {
  authority: Extract<ActivationAttempt["authority"], { kind: "lead-agent-self-repair" }>;
};

export interface SelfRepairActivation {
  protectedRecovery(): { actor: RecoveryActorIdentity; policy: RecoveryPolicyIdentity };
  // Reconciliation reaches a terminal actor phase before a paused Commitment can stop new effects.
  reconcile(request: SelfRepairActivationRequest): Promise<{
    activationAttemptId: string;
    outcome: "activated" | "rolled-back";
    evidence: string[];
  } | undefined>;
  activate(request: SelfRepairActivationRequest): Promise<{
    activationAttemptId: string;
    outcome: "activated" | "rolled-back";
    evidence: string[];
  }>;
}

export interface SelfRepairController {
  begin(input: {
    commitmentId: string;
    defect: { subject: string; description: string; evidence: string[] };
    hypothesis: string;
    authority: Omit<SelfRepairRecord["authority"], "protectedRecoveryActor" | "protectedRecoveryPolicy">;
    envelope: SelfRepairRecord["envelope"];
  }): SelfRepairRecord;
  advance(selfRepairId: string): Promise<SelfRepairRecord>;
  retry(
    selfRepairId: string,
    input: { hypothesis: string; changedEvidence: string[] },
  ): SelfRepairRecord;
  view(selfRepairId: string): SelfRepairRecord | undefined;
}

const activationHealthCriteria: SelfRepairActivationRequest["healthCriteria"] = [
  "exact-identity",
  "artifact-integrity",
  "authoritative-state",
  "write-generation",
  "conversation-context",
  "write-read-probe",
  "recovery-handshake",
];

export function createSelfRepairController(
  state: SelfRepairState,
  dependencies: { workers: SelfRepairWorkers; preparation: SelfRepairPreparation } & SelfRepairActivation,
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
        throw new Error("Self-repair requires one active Commitment.");
      }
      const id = randomUUID();
      const diagnosedAt = new Date().toISOString();
      const protectedRecovery = dependencies.protectedRecovery();
      validateProtectedRecovery(protectedRecovery);
      if (pathsOverlap(input.authority.authorizedWriteRoot, protectedRecovery.actor.path)) {
        throw new Error("The Self-repair Authorized Write Root cannot overlap the protected Recovery Actor.");
      }
      const repair: SelfRepairRecord = {
        version: 1,
        id,
        commitmentId: input.commitmentId,
        defect: { ...input.defect, evidence: [...input.defect.evidence], diagnosedAt },
        authority: {
          ...input.authority,
          authorizedWriteRoot: resolve(input.authority.authorizedWriteRoot),
          protectedRecoveryActor: protectedRecovery.actor,
          protectedRecoveryPolicy: protectedRecovery.policy,
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
                protectedRecoveryActor: repair.authority.protectedRecoveryActor,
                budget: attempt.budget,
              });
            validateWorkerReference(implementationWorker, false);
            validateDurableWorker(
              state,
              repair,
              attempt,
              implementationWorker,
              false,
              false,
            );
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
              false,
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
                protectedRecoveryActor: repair.authority.protectedRecoveryActor,
              });
            validateCandidateOutcome(outcome, workerCandidate);
            repair = appendAttempt(repair, {
              ...attempt,
              status: "review-delegation-pending",
              candidate: outcome.candidate,
              baseline: outcome.baseline,
              changedTargets: [...outcome.changedTargets],
              compatibility: outcome.compatibility,
              verification: outcome.verification,
              recoveryPath: outcome.recoveryPath,
            });
            continue;
          }
          case "review-delegation-pending": {
            const reviewWorker =
              await dependencies.workers.reviewDelegation(attempt.id) ??
              await dependencies.workers.delegateReview({
                selfRepairId: repair.id,
                attemptId: attempt.id,
                attemptNumber: attempt.budget.attemptNumber,
                commitmentId: repair.commitmentId,
                implementationWorker: attempt.implementationWorker!,
                candidate: attempt.candidate!,
                verification: attempt.verification!,
              });
            validateWorkerReference(reviewWorker, true);
            if (reviewWorker.workerSessionId === attempt.implementationWorker!.workerSessionId) {
              throw new Error("Self-repair Review must use an independent Worker Session.");
            }
            validateDurableWorker(state, repair, attempt, reviewWorker, true, false);
            repair = appendAttempt(repair, {
              ...attempt,
              status: "review-delegated",
              reviewWorker,
            });
            continue;
          }
          case "review-delegated": {
            const pendingWorker = validateDurableWorker(
              state,
              repair,
              attempt,
              attempt.reviewWorker!,
              true,
              false,
            );
            if (pendingWorker.worker.state !== "completed" || pendingWorker.execution.status !== "completed") {
              return repair;
            }
            const workerEvidence = validateDurableWorker(
              state,
              repair,
              attempt,
              attempt.reviewWorker!,
              true,
              true,
            );
            const findings = workerEvidence.worker.outcome?.reviewFindings;
            if (!findings) {
              throw new Error("The reviewing Worker did not durably report independent Review findings.");
            }
            const review: SelfRepairReviewOutcome = {
              verdict: findings.some((finding) => finding.disposition === "must-fix")
                ? "changes-requested"
                : "passed",
              evidence: workerEvidence.worker.outcome!.verificationResults,
            };
            validateEvidence(review.evidence, "Self-repair Review");
            validateReviewOutcome(review, workerEvidence.worker);
            if (review.verdict !== "passed") {
              return appendAttempt(repair, { ...attempt, status: "blocked", review });
            }
            repair = appendAttempt(repair, {
              ...attempt,
              status: "activation-pending",
              review,
            });
            continue;
          }
          case "activation-pending": {
            const request: SelfRepairActivationRequest = {
              candidate: attempt.candidate!,
              baseline: attempt.baseline!,
              authority: {
                kind: "lead-agent-self-repair",
                selfRepairId: repair.id,
                selfRepairAttemptId: attempt.id,
                commitmentId: repair.commitmentId,
                recoveryActorRevision: repair.authority.protectedRecoveryActor.revision,
                recoveryActorDigest: repair.authority.protectedRecoveryActor.digest,
                recoveryActorPath: repair.authority.protectedRecoveryActor.path,
                recoveryPolicyRevision: repair.authority.protectedRecoveryPolicy.revision,
                recoveryPolicyDigest: repair.authority.protectedRecoveryPolicy.digest,
                authorizedAt: repair.authority.authorizedAt,
              },
              compatibility: attempt.compatibility!,
              verification: attempt.verification!,
              review: { verdict: "passed", evidence: attempt.review!.evidence },
              healthCriteria: [...activationHealthCriteria],
              budget: { deadline: attempt.budget.deadline, probationChecks: 2 },
              recoveryPath: attempt.recoveryPath!,
            };
            let result = await dependencies.reconcile(request);
            if (!result) {
              requireActiveCommitment(state, repair.commitmentId);
              assertWithinDeadline(attempt);
              await dependencies.activate(request);
              return repair;
            }
            if (!result.activationAttemptId.trim()) {
              throw new Error("Self-repair activation requires an exact Activation Attempt identity.");
            }
            validateEvidence(result.evidence, "Self-repair activation");
            const observedAt = new Date().toISOString();
            const status = result.outcome;
            return appendAttempt(repair, {
              ...attempt,
              status,
              activation: {
                attemptId: result.activationAttemptId,
                outcome: result.outcome,
                evidence: result.evidence,
                observedAt,
                account: result.outcome === "activated"
                  ? `Self-repair activated revision ${attempt.candidate!.code.revision} for ${repair.defect.subject}. ` +
                    `Evidence: ${result.evidence.join("; ")}. Effects: ${attempt.changedTargets!.join(", ")}. ` +
                    "Residual uncertainty: Recovery Baseline promotion remains a later decision."
                  : `Self-repair revision ${attempt.candidate!.code.revision} for ${repair.defect.subject} ` +
                    `failed health under hypothesis ${attempt.hypothesis} and rolled back before another attempt. ` +
                    `Evidence: ${result.evidence.join("; ")}. Effects: candidate cutover was reverted. ` +
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
        throw new Error("Self-repair retry requires a completed rollback or blocked reviewed candidate.");
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
    throw new Error("Self-repair requires a Commitment, concrete defect, and repair hypothesis.");
  }
  validateEvidence(input.defect.evidence, "Self-repair diagnosis");
  if (
    input.authority.kind !== "lead-agent-command-authority" ||
    !input.authority.authorizedWriteRoot.trim() ||
    !Number.isFinite(Date.parse(input.authority.authorizedAt))
  ) {
    throw new Error("Self-repair requires exact Command Authority and protected recovery identities.");
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
    !outcome.code.path.trim() ||
    pathsOverlap(outcome.code.path, repair.authority.protectedRecoveryActor.path)
  ) {
    throw new Error("A Self-repair candidate must be immutable and cannot replace the Recovery Actor.");
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
    assignment.effectClasses.length !== 2 ||
    !assignment.effectClasses.includes("filesystem-write") ||
    !assignment.effectClasses.includes("bounded-process-execution") ||
    assignment.authorizedWriteRoots.length !== 1 ||
    !samePath(assignment.authorizedWriteRoots[0]!, repair.authority.authorizedWriteRoot) ||
    !samePath(assignment.checkoutIsolation.root, repair.authority.authorizedWriteRoot) ||
    assignment.authority.commitmentId !== repair.commitmentId ||
    Date.parse(assignment.authority.validatedAt) + assignment.timeoutMs > Date.parse(repair.envelope.deadline) ||
    outcome.changedTargets.some((changedTarget) =>
      !assignment.targets.some((target) => {
        const targetPath = resolve(repair.authority.authorizedWriteRoot, target);
        const changedPath = resolve(repair.authority.authorizedWriteRoot, changedTarget);
        return samePath(targetPath, changedPath) || isWithin(targetPath, changedPath);
      })
    )
  ) {
    throw new Error("Self-repair candidate work exceeded its durable authority or effect envelope.");
  }
}

function validateCandidateOutcome(
  outcome: SelfRepairCandidateOutcome,
  workerCandidate: SelfRepairWorkerCandidate,
): void {
  if (
    JSON.stringify(outcome.candidate.code) !== JSON.stringify(workerCandidate.code) ||
    JSON.stringify(outcome.changedTargets) !== JSON.stringify(workerCandidate.changedTargets)
  ) {
    throw new Error("Prepared Self-repair evidence does not match the implementing Worker candidate.");
  }
  if (outcome.compatibility.stateSchema !== "lossless-return-proven" || !outcome.compatibility.evidence.trim()) {
    throw new Error("Self-repair activation requires a lossless state recovery path.");
  }
  if (outcome.verification.verdict !== "passed") {
    throw new Error("Self-repair candidate Verification must pass before Review.");
  }
  validateEvidence(outcome.verification.evidence, "Self-repair Verification");
  if (outcome.recoveryPath !== "restore-exact-baseline-pair") {
    throw new Error("Self-repair requires exact Recovery Baseline restoration.");
  }
  if (
    outcome.baseline.code.revision === outcome.candidate.code.revision ||
    outcome.baseline.state.digest !== outcome.candidate.state.digest ||
    !samePath(outcome.baseline.state.snapshotPath, outcome.candidate.state.snapshotPath)
  ) {
    throw new Error("Self-repair rollback requires trusted prior code with fresh pre-cutover state.");
  }
}

function validateReviewOutcome(review: SelfRepairReviewOutcome, worker: WorkerSession): void {
  const findings = worker.outcome?.reviewFindings;
  const expectedVerdict = findings?.some((finding) => finding.disposition === "must-fix")
    ? "changes-requested"
    : "passed";
  if (
    !worker.outcome ||
    !findings ||
    review.verdict !== expectedVerdict ||
    review.evidence.some((evidence) => !worker.outcome!.verificationResults.includes(evidence))
  ) {
    throw new Error("Self-repair Review must match the durable reviewing Worker outcome.");
  }
}

function validateWorkerReference(worker: SelfRepairWorkerReference, expectedReadOnly: boolean): void {
  if (
    !worker.workerSessionId.trim() ||
    !worker.executionAttemptId.trim() ||
    worker.readOnly !== expectedReadOnly
  ) {
    throw new Error("Self-repair delegation requires exact Worker Session and execution identities.");
  }
}

function validateDurableWorker(
  state: SelfRepairState,
  repair: SelfRepairRecord,
  attempt: SelfRepairAttempt,
  reference: SelfRepairWorkerReference,
  expectedReadOnly: boolean,
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
    worker.assignment.readOnly !== expectedReadOnly ||
    worker.assignment.commitmentId !== repair.commitmentId ||
    worker.assignment.selfRepair?.selfRepairId !== repair.id ||
    worker.assignment.selfRepair.attemptId !== attempt.id ||
    (!expectedReadOnly && worker.assignment.coordination?.role !== "implementer") ||
    (expectedReadOnly &&
      (worker.assignment.coordination?.role !== "reviewer" ||
        worker.assignment.coordination.reviewOfWorkerSessionId !==
          attempt.implementationWorker?.workerSessionId))
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
    throw new Error("Self-repair effects stop while their Commitment is not active.");
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

function pathsOverlap(left: string, right: string): boolean {
  return samePath(left, right) || isWithin(left, right) || isWithin(right, left);
}

function validateProtectedRecovery(input: {
  actor: RecoveryActorIdentity;
  policy: RecoveryPolicyIdentity;
}): void {
  if (
    !input.actor.revision.trim() ||
    !isDigest(input.actor.digest) ||
    !input.actor.path.trim() ||
    input.policy.revision !== protectedRecoveryPolicyIdentity.revision ||
    input.policy.digest !== protectedRecoveryPolicyIdentity.digest
  ) {
    throw new Error("Self-repair requires exact protected Recovery Actor and policy identity.");
  }
}

export function createRecoveryActorSelfRepairActivation(
  actor: RecoveryActor,
): SelfRepairActivation {
  const result = (attempt: ActivationAttempt) => ({
    activationAttemptId: attempt.id,
    outcome: attempt.phase === "activated" ? "activated" as const : "rolled-back" as const,
    evidence: attempt.health?.evidence.length
      ? attempt.health.evidence
      : [attempt.failure ?? `Activation Attempt ${attempt.id} reached ${attempt.phase}.`],
  });
  const matchingAttempt = (request: SelfRepairActivationRequest): ActivationAttempt | undefined => {
    const attempt = actor.inspectSelfRepairAttempt(
      request.authority.selfRepairId,
      request.authority.selfRepairAttemptId,
    );
    if (!attempt) return undefined;
    const authority = attempt?.authority;
    if (
      authority?.kind !== "lead-agent-self-repair" ||
      authority.selfRepairId !== request.authority.selfRepairId ||
      authority.selfRepairAttemptId !== request.authority.selfRepairAttemptId
    ) return undefined;
    const exactRequest =
      JSON.stringify(attempt.candidate) === JSON.stringify(request.candidate) &&
      JSON.stringify(attempt.baseline) === JSON.stringify(request.baseline) &&
      JSON.stringify(attempt.authority) === JSON.stringify(request.authority) &&
      JSON.stringify(attempt.compatibility) === JSON.stringify(request.compatibility) &&
      JSON.stringify(attempt.verification) === JSON.stringify(request.verification) &&
      JSON.stringify(attempt.review) === JSON.stringify(request.review) &&
      JSON.stringify(attempt.healthCriteria) === JSON.stringify(request.healthCriteria) &&
      JSON.stringify(attempt.budget) === JSON.stringify(request.budget) &&
      attempt.recoveryPath === request.recoveryPath;
    if (!exactRequest) {
      throw new Error("Self-repair activation reconciliation found ambiguous request evidence.");
    }
    return attempt;
  };
  return {
    protectedRecovery() {
      const identity = actor.inspect().actor;
      if (!identity) throw new Error("Recovery Actor is not initialized.");
      return { actor: identity, policy: protectedRecoveryPolicyIdentity };
    },
    async reconcile(request) {
      let attempt = matchingAttempt(request);
      if (!attempt) return undefined;
      if (attempt.phase !== "activated" && attempt.phase !== "rolled-back") {
        await actor.recover();
        attempt = matchingAttempt(request);
      }
      return attempt && (attempt.phase === "activated" || attempt.phase === "rolled-back")
        ? result(attempt)
        : undefined;
    },
    async activate(request) {
      const activation = await actor.activate(request);
      const attempt = actor.inspect().currentAttempt;
      if (!attempt || attempt.id !== activation.attemptId) {
        throw new Error("Recovery Actor did not retain the exact Self-repair Activation Attempt.");
      }
      return result(attempt);
    },
  };
}
