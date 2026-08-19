import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type { ModelSelection } from "../model-selection.ts";
import { assertEffectEvidenceSupportsDisposition } from "../target-project-operations/index.ts";
import type {
  EffectIntent,
  EffectReconciliation,
  TargetProjectOperationEffectIntent,
  TargetProjectOperationAttempt,
  TargetProjectOperationRequest,
  TargetProjectOperationResult,
} from "../target-project-operations/index.ts";

export type OwnerConfiguration = {
  targetProject: { path: string };
  modelSelection: ModelSelection;
  modelFallbacks?: ModelSelection[];
  modelRequirements?: LeadModelRequirements;
  modelPolicyRevision: string;
  workerModelPolicy?: {
    revision: string;
    selection: WorkerModelSelection;
  };
};

export type LeadModelRequirements = {
  requiredCapabilities: Array<"text" | "image">;
  minimumContextWindow: number;
  dataHandling: "loopback-only" | "supported-integrations";
  maximumInputCostPerMillionUsd: number | null;
};

export const defaultLeadModelRequirements: LeadModelRequirements = {
  requiredCapabilities: ["text"],
  minimumContextWindow: 1,
  dataHandling: "supported-integrations",
  maximumInputCostPerMillionUsd: null,
};

export type LeadModelPolicy = {
  revision: string;
  default: ModelSelection;
  fallbacks: ModelSelection[];
  requirements: LeadModelRequirements;
};

export type ModelCandidateValidation = {
  modelSelection: ModelSelection;
  requirements: LeadModelRequirements;
  hardGates: {
    integration: "passed" | "failed" | "unknown";
    authentication: "passed" | "failed" | "unknown";
    intendedIdentity: "passed" | "failed" | "unknown";
    requiredCapabilities: "passed" | "failed" | "unknown";
    context: "passed" | "failed" | "unknown";
    dataHandling: "passed" | "failed" | "unknown";
    cost: "passed" | "failed" | "unknown";
  };
  availability: "passed" | "failed" | "unknown";
  observedAt: string;
};

export type CommitmentCriterion =
  | {
      id: string;
      kind: "response-includes";
      description: string;
      expectedText: string;
    }
  | {
      id: string;
      kind: "owner-judgment";
      description: string;
    }
  | {
      id: string;
      kind: "target-project-operation";
      description: string;
      operation: "test";
    };

export type CommitmentState =
  | "committed"
  | "ready"
  | "active"
  | "verifying"
  | "awaiting-acceptance"
  | "accepted"
  | "cancelled"
  | "superseded";

export type Commitment = {
  id: string;
  outcome: string;
  criteria: CommitmentCriterion[];
  createdByOwnerTurnId: string;
  activeOwnerTurnId: string;
  state: CommitmentState;
  condition?: {
    kind: "blocked" | "paused" | "reconciling";
    reason: string;
    nextAction: string;
  };
  disposition?: {
    kind: "cancelled" | "superseded";
    reason: string;
    ownerTurnId: string;
    replacementCommitmentId?: string;
  };
  verification?: {
    passed: boolean;
    verifiedAt: string;
    evidence: Array<{
      id: string;
      criterionId: string;
      description: string;
      source: "lead-agent-response" | "target-project-operation-result";
      operationAttemptId?: string;
    }>;
  };
  acceptance?:
    | {
        authority: "lead-agent";
        basis: "objective-criteria";
        acceptedAt: string;
      }
    | {
        authority: "owner";
        basis: "owner-verdict";
        ownerTurnId: string;
        acceptedAt: string;
      };
};

export type CommitmentDraft = {
  outcome: string;
  criteria: Array<
    | {
        kind: "response-includes";
        description: string;
        expectedText: string;
      }
    | {
        kind: "owner-judgment";
      }
    | {
        kind: "target-project-operation";
        description: string;
        operation: "test";
      }
  >;
};

export type LeadTurnAttempt = {
  id: string;
  ownerTurnId: string;
  modelSelection: ModelSelection;
  modelPolicyRevision: string;
  nativeHarness: null;
  selectionReason?: "fallback-after-ineligible-candidate";
  status: "started" | "completed" | "failed";
  failureKind?:
    | "unavailable"
    | "aborted"
    | "invalid-response"
    | "turn-failed"
    | "continuity-lost";
};

export type WorkerModelSelection =
  | {
      provider: "openai";
      model: string;
      nativeHarness: "codex";
    }
  | {
      provider: "anthropic";
      model: string;
      nativeHarness: "claude";
    }
  | {
      provider: "github";
      model: string;
      nativeHarness: "copilot";
    };

export type WorkerNativeHarnessSelection =
  | { provider: "openai"; nativeHarness: "codex" }
  | { provider: "anthropic"; nativeHarness: "claude" }
  | { provider: "github"; nativeHarness: "copilot" };

export type WorkerNativeCapabilities = {
  readOnly: boolean;
  nativeQuestions: boolean;
  cancellation: boolean;
  providerSessionResume: boolean;
  providerSessionLoad: "unavailable" | "conversation-replay-only";
  providerSessionDeletion: boolean;
  nativeChildControl: boolean;
  exactExecutionResume: "live-connection-only" | "unavailable";
  protocolSchemaSha256: string;
  writeIsolation?: "authorized-write-root-enforced";
};

export function assertSupportedWorkerModelSelection(selection: WorkerModelSelection): void {
  const supported =
    (selection.provider === "openai" &&
      selection.nativeHarness === "codex" &&
      selection.model === "gpt-5.6-sol") ||
    (selection.provider === "anthropic" &&
      selection.nativeHarness === "claude" &&
      selection.model === "claude-sonnet-5") ||
    (selection.provider === "github" &&
      selection.nativeHarness === "copilot" &&
      selection.model === "auto");
  if (!supported) {
    throw new Error("Worker Model Policy selects an unsupported Provider, Model, or Native Harness.");
  }
}

export type WorkerSession = {
  id: string;
  assignment: WorkerAssignment;
  state:
    | "starting"
    | "running"
    | "waiting-question"
    | "cancellation-requested"
    | "reconciling"
    | "completed"
    | "blocked"
    | "failed"
    | "cancelled";
  currentExecutionAttemptId: string;
  cancellation?: {
    kind: "owner" | "deadline";
    requestedAt: string;
    requestedByOwnerTurnId?: string;
    reason: string;
  };
  outcome?: WorkerOutcome;
};

type WorkerAssignmentBase = {
    objective: string;
    prompt: string;
    targetProjectPath: string;
    modelPolicyRevision: string;
    commitmentId?: string;
};

export type WorkerAssignment =
  | (WorkerAssignmentBase & { readOnly: true })
  | (WorkerAssignmentBase & {
      readOnly: false;
      commitmentId: string;
      targets: string[];
      effectClasses: ["filesystem-write", "bounded-process-execution"];
      authorizedWriteRoots: [string];
      timeoutMs: number;
      costBound: { maximumIncrementalSpendUsd: 0 };
      checkoutIsolation: {
        root: string;
        baselineCommit: string;
        isolation: { kind: "branch"; branch: string } | { kind: "worktree"; branch?: string };
      };
      authority: {
        kind: "lead-agent-command-authority";
        commitmentId: string;
        validatedAt: string;
      };
      recoveryConstraint: "reconcile-before-replay";
      verification: {
        operation: "test";
        workingDirectory: string;
        timeoutMs: number;
      };
    });

export type WorkerOutcome = {
  status: "completed" | "blocked" | "failed" | "cancelled" | "timed-out";
  summary: string;
  affectedArtifacts: string[];
  materialCommands: string[];
  verificationResults: string[];
  unresolvedUncertainty?: string;
  evidence: {
    providerSessionId?: string;
    nativeExecutionId?: string;
    harnessVersion?: string;
    baselineCommit?: string;
  };
};

export type WorkerReportedOutcome = {
  status: "completed" | "blocked";
  summary: string;
  affectedArtifacts: string[];
  verificationResults: string[];
  unresolvedUncertainty?: string;
};

export type WorkerExecutionAttempt = {
  id: string;
  workerSessionId: string;
  generation: number;
  modelSelection: WorkerModelSelection;
  modelPolicyRevision: string;
  effectIntentId?: string;
  dispatch?: {
    leaseId: string;
    claimedAt: string;
  };
  status:
    | "launch-intent-recorded"
    | "dispatching"
    | "starting"
    | "running"
    | "completed"
    | "blocked"
    | "failed"
    | "cancelled"
    | "timed-out"
    | "continuity-lost";
  providerSessionId?: string;
  nativeExecutionId?: string;
  process?: { pid: number; startedAt: string };
  harnessVersion?: string;
  protocolSchemaSha256?: string;
  capabilities?: WorkerNativeCapabilities;
  output?: string;
  failure?: string;
  outcome?: WorkerOutcome;
};

export type WorkerQuestion = {
  id: string;
  workerSessionId: string;
  executionAttemptId: string;
  providerRequestId: number | string;
  itemId: string;
  questions: Array<{
    id: string;
    question: string;
    options?: Array<{ label: string; description?: string }>;
    isOther: boolean;
  }>;
  status: "open" | "answer-recorded" | "delivered" | "cancelled";
  answer?: {
    ownerTurnId: string;
    answers: Record<string, string[]>;
    recordedAt: string;
  };
  deliveredExecutionAttemptId?: string;
};

export type CapabilityNotice = {
  id: "codex-worker";
  state: "active" | "cleared";
  fingerprint: string;
  detail: string;
  targetProjectPath: string;
  expectedIdentity: "ChatGPT";
  observedAt: string;
};

export interface OrchestrationState {
  readOwnerConversation(): OwnerConfiguration | undefined;
  leadAgentResponse(ownerTurnId: string): string | undefined;
  replaceOwnerConfiguration(configuration: OwnerConfiguration): void;
  ownerTurnSequence(turnId: string): number | undefined;
  readCommitments(): Commitment[];
  readCommitment(commitmentId: string): Commitment | undefined;
  appendCommitmentSnapshots(snapshots: Commitment[]): void;
  appendLeadTurnAttemptSnapshots(snapshots: LeadTurnAttempt[]): void;
  readLeadTurnAttempt(attemptId: string): LeadTurnAttempt | undefined;
  readLeadTurnAttempts(): LeadTurnAttempt[];
  appendWorkerSessionSnapshots(snapshots: WorkerSession[]): void;
  readWorkerSession(workerSessionId: string): WorkerSession | undefined;
  readWorkerSessions(): WorkerSession[];
  appendWorkerExecutionAttemptSnapshots(snapshots: WorkerExecutionAttempt[]): void;
  readWorkerExecutionAttempt(attemptId: string): WorkerExecutionAttempt | undefined;
  readWorkerExecutionAttempts(): WorkerExecutionAttempt[];
  appendWorkerQuestionSnapshots(snapshots: WorkerQuestion[]): void;
  readWorkerQuestion(questionId: string): WorkerQuestion | undefined;
  readWorkerQuestions(): WorkerQuestion[];
  startWorkerExecution(
    workerSessionSnapshots: WorkerSession[],
    executionAttempt: WorkerExecutionAttempt,
    effectIntent?: EffectIntent,
  ): void;
  appendWorkerState(input: {
    workerSession?: WorkerSession;
    executionAttempt?: WorkerExecutionAttempt;
    questions?: WorkerQuestion[];
    effectIntent?: EffectIntent;
  }): void;
  settleWorkerVerification(
    effectIntent: Extract<EffectIntent, { kind: "worker-assignment" }>,
    commitmentSnapshots: Commitment[],
  ): void;
  readCapabilityNotice(id: CapabilityNotice["id"]): CapabilityNotice | undefined;
  appendCapabilityNotice(notice: CapabilityNotice): void;
  settleTargetProjectOperation(
    attempt: TargetProjectOperationAttempt,
    effectIntent: TargetProjectOperationEffectIntent,
  ): void;
  readTargetProjectOperationAttempt(attemptId: string): TargetProjectOperationAttempt | undefined;
  readTargetProjectOperationAttempts(): TargetProjectOperationAttempt[];
  readEffectIntent(effectIntentId: string): EffectIntent | undefined;
  readEffectIntents(): EffectIntent[];
  reconcileEffectIntent(effectIntent: EffectIntent): void;
}

export interface OrchestrationCore {
  workerSessionsView(): WorkerSession[];
  workerQuestionsView(): WorkerQuestion[];
  workerSessionView(workerSessionId: string): WorkerSession | undefined;
  workerExecutionAttemptView(executionAttemptId: string): WorkerExecutionAttempt | undefined;
  workerRecoveryView(): Array<{
    workerSession: WorkerSession;
    executionAttempt: WorkerExecutionAttempt;
  }>;
  workerVerificationRecoveryView(): Array<{
    workerSession: WorkerSession;
    executionAttempt: WorkerExecutionAttempt;
  }>;
  workerVerificationRequest(
    workerSessionId: string,
    executionAttemptId: string,
  ): TargetProjectOperationRequest;
  observeCodexCapabilityUnavailable(
    detail: string,
    targetProjectPath: string,
  ): "recorded" | "deduplicated";
  observeCodexCapabilityAvailable(): "cleared" | "unchanged";
  activateLeadModelPolicy(
    policy: LeadModelPolicy,
    validations: readonly ModelCandidateValidation[],
  ): void;
  recordCommitment(ownerTurnId: string, draft: CommitmentDraft): Commitment;
  reconcileInterruptedCommitments(): void;
  reconcileEffect(input: {
    effectIntentId: string;
    disposition: EffectReconciliation["disposition"];
    evidence: EffectReconciliation["evidence"];
  }): void;
  resumeCommitment(commitmentId: string, ownerTurnId: string): void;
  pauseCommitment(commitmentId: string, ownerTurnId: string, reason: string): void;
  cancelCommitment(commitmentId: string, ownerTurnId: string, reason: string): void;
  supersedeCommitment(
    commitmentId: string,
    ownerTurnId: string,
    reason: string,
    replacementCommitmentId: string,
  ): void;
  observeLeadResponse(ownerTurnId: string, leadAgentResponse: string): void;
  observeTargetProjectOperationResult(
    commitmentId: string,
    result: TargetProjectOperationResult,
  ): void;
  observeWorkerVerificationResult(
    workerSessionId: string,
    executionAttemptId: string,
    result: TargetProjectOperationResult,
  ): void;
  observeLeadTurnFailure(ownerTurnId: string, reason: string): void;
  acceptCommitment(commitmentId: string, ownerTurnId: string): void;
  modelCandidateDecision(validation: ModelCandidateValidation): "use" | "skip";
  modelFailureDecision(failure: {
    kind: "unavailable" | "aborted" | "invalid-response" | "turn-failed";
    commitmentMutationApplied: boolean;
  }): "fallback" | "revalidate" | "stop";
  startLeadTurnAttempt(input: {
    ownerTurnId: string;
    modelSelection: ModelSelection;
    modelPolicyRevision: string;
    selectionReason?: "fallback-after-ineligible-candidate";
  }): LeadTurnAttempt;
  settleLeadTurnAttempt(
    attemptId: string,
    status: "completed" | "failed",
    failureKind?: LeadTurnAttempt["failureKind"],
  ): void;
  delegateReadOnlyWorker(input: {
    objective: string;
    prompt: string;
    targetProjectPath: string;
    modelSelection: WorkerModelSelection;
    modelPolicyRevision: string;
    commitmentId?: string;
  }): { workerSession: WorkerSession; executionAttempt: WorkerExecutionAttempt };
  delegateEffectfulWorker(input: {
    objective: string;
    prompt: string;
    targetProjectPath: string;
    modelSelection: WorkerModelSelection;
    modelPolicyRevision: string;
    commitmentId: string;
    targets: string[];
    timeoutMs: number;
    checkoutIsolation: {
      root: string;
      baselineCommit: string;
      isolation: { kind: "branch"; branch: string } | { kind: "worktree"; branch?: string };
    };
    verification: { operation: "test"; workingDirectory: string; timeoutMs: number };
  }): { workerSession: WorkerSession; executionAttempt: WorkerExecutionAttempt };
  observeWorkerAttemptStarted(input: {
    workerSessionId: string;
    executionAttemptId: string;
    providerSessionId: string;
    nativeExecutionId: string;
    process: { pid: number; startedAt: string };
    harnessVersion: string;
    capabilities: WorkerNativeCapabilities;
    writeIsolation?: "authorized-write-root-enforced";
  }): void;
  observeWorkerProcessStarted(input: {
    workerSessionId: string;
    executionAttemptId: string;
    process: { pid: number; startedAt: string };
    harnessVersion: string;
    protocolSchemaSha256: string;
  }): void;
  claimWorkerLaunch(
    workerSessionId: string,
    executionAttemptId: string,
  ): WorkerExecutionAttempt;
  claimWorkerEffectDispatch(workerSessionId: string, executionAttemptId: string): void;
  observeWorkerQuestion(input: {
    workerSessionId: string;
    executionAttemptId: string;
    providerRequestId: number | string;
    itemId: string;
    questions: WorkerQuestion["questions"];
  }): WorkerQuestion;
  recordWorkerAnswer(
    questionId: string,
    ownerTurnId: string,
    answers: Record<string, string[]>,
  ): WorkerQuestion;
  observeWorkerAnswerDelivered(questionId: string): void;
  observeWorkerAnswersReplayed(
    workerSessionId: string,
    executionAttemptId: string,
    questionIds: string[],
  ): void;
  requestWorkerCancellation(
    workerSessionId: string,
    ownerTurnId: string,
    reason: string,
  ): void;
  requestWorkerDeadlineExceeded(workerSessionId: string): void;
  observeWorkerTerminal(input: {
    workerSessionId: string;
    executionAttemptId: string;
    status: "completed" | "failed" | "interrupted";
    processGone: boolean;
    output?: string;
    detail?: string;
    materialCommands?: string[];
    observedChanges?: string[];
    reportedOutcome?: WorkerReportedOutcome;
  }): "settled" | "stale";
  recordWorkerContinuityLoss(
    workerSessionId: string,
    executionAttemptId: string,
    reason: string,
  ): void;
  reconcileInterruptedWorkers(reason: string): void;
  recoverWorker(
    workerSessionId: string,
    processGone: boolean,
  ):
    | { kind: "restart"; workerSession: WorkerSession; executionAttempt: WorkerExecutionAttempt }
    | { kind: "settled" | "blocked" };
}

export function createOrchestrationCore(state: OrchestrationState): OrchestrationCore {
  return {
    workerSessionsView() {
      return state.readWorkerSessions();
    },

    workerQuestionsView() {
      return state.readWorkerQuestions();
    },

    workerSessionView(workerSessionId) {
      return state.readWorkerSession(workerSessionId);
    },

    workerExecutionAttemptView(executionAttemptId) {
      return state.readWorkerExecutionAttempt(executionAttemptId);
    },

    workerRecoveryView() {
      return state
        .readWorkerSessions()
        .filter((worker) => !["completed", "blocked", "failed", "cancelled"].includes(worker.state))
        .map((worker) => {
          const executionAttempt = state.readWorkerExecutionAttempt(
            worker.currentExecutionAttemptId,
          );
          if (!executionAttempt) {
            throw new Error(`Worker Session ${worker.id} has no current execution attempt.`);
          }
          return { workerSession: worker, executionAttempt };
        });
    },

    workerVerificationRecoveryView() {
      return state.readWorkerSessions().flatMap((worker) => {
        if (worker.assignment.readOnly || worker.state !== "completed") return [];
        const attempt = state.readWorkerExecutionAttempt(worker.currentExecutionAttemptId);
        const effect = attempt?.effectIntentId
          ? state.readEffectIntent(attempt.effectIntentId)
          : undefined;
        return attempt &&
          attempt.status === "completed" &&
          effect?.kind === "worker-assignment" &&
          effect.status === "succeeded" &&
          !effect.verificationOperationAttemptId
          ? [{ workerSession: worker, executionAttempt: attempt }]
          : [];
      });
    },

    workerVerificationRequest(workerSessionId, executionAttemptId) {
      const worker = requireWorkerSession(state, workerSessionId);
      const attempt = requireCurrentWorkerAttempt(state, worker, executionAttemptId);
      const effect = attempt.effectIntentId
        ? state.readEffectIntent(attempt.effectIntentId)
        : undefined;
      if (
        worker.assignment.readOnly ||
        worker.state !== "completed" ||
        attempt.status !== "completed" ||
        effect?.kind !== "worker-assignment" ||
        effect.status !== "succeeded" ||
        effect.verificationOperationAttemptId
      ) {
        throw new Error("Worker effect is not ready for its attributed Verification operation.");
      }
      return {
        commitmentId: worker.assignment.commitmentId,
        operation: { kind: worker.assignment.verification.operation, inputs: {} },
        checkout: worker.assignment.targetProjectPath,
        workingDirectory: worker.assignment.verification.workingDirectory,
        timeoutMs: worker.assignment.verification.timeoutMs,
        causedByWorker: {
          workerSessionId: worker.id,
          executionAttemptId: attempt.id,
          generation: attempt.generation,
        },
      };
    },

    observeCodexCapabilityUnavailable(detail, targetProjectPath) {
      const fingerprint = `codex-cli 0.147.0|ChatGPT|${targetProjectPath}|${detail}`;
      const current = state.readCapabilityNotice("codex-worker");
      if (current?.state === "active" && current.fingerprint === fingerprint) {
        return "deduplicated";
      }
      state.appendCapabilityNotice({
        id: "codex-worker",
        state: "active",
        fingerprint,
        detail,
        targetProjectPath,
        expectedIdentity: "ChatGPT",
        observedAt: new Date().toISOString(),
      });
      return "recorded";
    },

    observeCodexCapabilityAvailable() {
      const current = state.readCapabilityNotice("codex-worker");
      if (!current || current.state === "cleared") return "unchanged";
      state.appendCapabilityNotice({
        ...current,
        state: "cleared",
        detail: "Codex capability was proven available again.",
        observedAt: new Date().toISOString(),
      });
      return "cleared";
    },

    activateLeadModelPolicy(policy, validations) {
      const existing = state.readOwnerConversation();
      if (!existing) throw new Error("Authoritative state is not configured.");
      assertValidatedLeadModelPolicy(policy, validations);
      state.replaceOwnerConfiguration({
        targetProject: existing.targetProject,
        modelSelection: policy.default,
        modelFallbacks: policy.fallbacks,
        modelRequirements: policy.requirements,
        modelPolicyRevision: policy.revision,
      });
    },

    recordCommitment(ownerTurnId, draft) {
      if (state.ownerTurnSequence(ownerTurnId) === undefined) {
        throw new Error(`Unknown Owner turn ${ownerTurnId}.`);
      }
      validateCommitmentDraft(draft);
      const committed: Commitment = {
        id: randomUUID(),
        outcome: draft.outcome,
        criteria: draft.criteria.map((criterion) =>
          criterion.kind !== "owner-judgment"
            ? { ...criterion, id: randomUUID() }
            : {
                ...criterion,
                id: randomUUID(),
                description: "A Lead Agent response is presented for Owner judgment.",
              },
        ),
        createdByOwnerTurnId: ownerTurnId,
        activeOwnerTurnId: ownerTurnId,
        state: "committed",
      };
      const ready = { ...committed, state: "ready" as const };
      const active = { ...ready, state: "active" as const };
      state.appendCommitmentSnapshots([committed, ready, active]);
      return active;
    },

    reconcileInterruptedCommitments() {
      for (const attempt of state.readLeadTurnAttempts()) {
        if (attempt.status !== "started") continue;
        const response = state.leadAgentResponse(attempt.ownerTurnId);
        if (response !== undefined) {
          observeLeadResponse(state, attempt.ownerTurnId, response);
          state.appendLeadTurnAttemptSnapshots([{ ...attempt, status: "completed" }]);
        } else {
          state.appendLeadTurnAttemptSnapshots([
            { ...attempt, status: "failed", failureKind: "continuity-lost" },
          ]);
        }
      }
      for (const attempt of state.readTargetProjectOperationAttempts()) {
        const effectIntent = state.readEffectIntent(attempt.effectIntentId);
        if (effectIntent?.kind !== "target-project-operation") continue;
        if (attempt.status === "ready" && effectIntent?.status === "pending") {
          const result: TargetProjectOperationResult = {
            operationAttemptId: attempt.id,
            effectIntentId: effectIntent.id,
            commitmentId: attempt.commitmentId,
            operation: attempt.operation,
            status: "rejected",
            discovery: attempt.discovery,
            affectedArtifacts: [],
            diagnostics: [
              {
                source: "task-cli",
                stream: "host",
                message: "Host restart occurred before Task dispatch.",
              },
            ],
            uncertainty: null,
            startedAt: attempt.startedAt,
            completedAt: new Date().toISOString(),
            ...(attempt.causedByWorker ? { causedByWorker: attempt.causedByWorker } : {}),
          };
          state.settleTargetProjectOperation(
            { ...attempt, status: "rejected", result },
            { ...effectIntent, status: "rejected" },
          );
          recordTargetProjectOperationVerification(state, attempt.commitmentId, result, "blocked");
          continue;
        }
        if (attempt.status !== "running") continue;
        if (!effectIntent || effectIntent.status !== "dispatching") continue;
        const completedAt = new Date().toISOString();
        const result: TargetProjectOperationResult = {
          operationAttemptId: attempt.id,
          effectIntentId: effectIntent.id,
          commitmentId: attempt.commitmentId,
          operation: attempt.operation,
          status: "unknown",
          discovery: attempt.discovery,
          affectedArtifacts: [],
          diagnostics: [
            {
              source: "task-cli",
              stream: "host",
              message: "Host restart lost Task process continuity after dispatch.",
            },
          ],
          uncertainty: {
            reason: "Host restart lost continuity with the dispatched Target Project operation.",
            nextAction: "Inspect declared artifacts and external effects before authorizing a new attempt.",
          },
          startedAt: attempt.startedAt,
          completedAt,
          ...(attempt.causedByWorker ? { causedByWorker: attempt.causedByWorker } : {}),
        };
        state.settleTargetProjectOperation(
          { ...attempt, status: "unknown", result },
          { ...effectIntent, status: "unknown" },
        );
        recordTargetProjectOperationVerification(state, attempt.commitmentId, result, "reconciling");
      }
      const commitmentsAwaitingWorkerVerification = new Set(
        this.workerVerificationRecoveryView().map(
          ({ workerSession }) => workerSession.assignment.commitmentId,
        ),
      );
      for (const commitment of state.readCommitments()) {
        if (commitment.state !== "active" || commitment.condition) continue;
        if (commitmentsAwaitingWorkerVerification.has(commitment.id)) continue;
        state.appendCommitmentSnapshots([
          {
            ...commitment,
            condition: {
              kind: "reconciling",
              reason: "Host restart lost continuity with the active Lead turn.",
              nextAction: "Resume this Commitment in a new attributed Owner turn.",
            },
          },
        ]);
      }
    },

    reconcileEffect(input) {
      const effectIntent = state.readEffectIntent(input.effectIntentId);
      if (!effectIntent || effectIntent.status !== "unknown") {
        throw new Error("Only an uncertain effect can be reconciled.");
      }
      assertEffectEvidenceSupportsDisposition(input.disposition, input.evidence);
      state.reconcileEffectIntent({
        ...effectIntent,
        status: "reconciled",
        reconciliation: {
          disposition: input.disposition,
          evidence: input.evidence,
          reconciledAt: new Date().toISOString(),
          reconciledBy: "lead-agent",
        },
      });
    },

    resumeCommitment(commitmentId, ownerTurnId) {
      const commitment = requireControlledCommitment(state, commitmentId, ownerTurnId);
      if (["accepted", "cancelled", "superseded"].includes(commitment.state) || !commitment.condition) {
        throw new Error(`Commitment ${commitmentId} is not resumable.`);
      }
      if (
        state.readEffectIntents().some(
          (effectIntent) =>
            effectIntent.commitmentId === commitmentId && effectIntent.status === "unknown",
        )
      ) {
        throw new Error(`Commitment ${commitmentId} has an uncertain effect that requires reconciliation.`);
      }
      const { condition: _condition, ...unblocked } = commitment;
      state.appendCommitmentSnapshots([
        {
          ...unblocked,
          ...(commitment.state === "active" ? { activeOwnerTurnId: ownerTurnId } : {}),
        },
      ]);
    },

    pauseCommitment(commitmentId, ownerTurnId, reason) {
      const commitment = requireControlledCommitment(state, commitmentId, ownerTurnId);
      assertNonterminalCommitment(commitment);
      if (!reason.trim()) throw new Error("Pausing a Commitment requires a reason.");
      state.appendCommitmentSnapshots([
        {
          ...commitment,
          condition: {
            kind: "paused",
            reason,
            nextAction: "Resume the Commitment in a later Owner turn.",
          },
        },
      ]);
    },

    cancelCommitment(commitmentId, ownerTurnId, reason) {
      const commitment = requireControlledCommitment(state, commitmentId, ownerTurnId);
      assertNonterminalCommitment(commitment);
      if (!reason.trim()) throw new Error("Cancelling a Commitment requires a reason.");
      const { condition: _condition, acceptance: _acceptance, ...remaining } = commitment;
      state.appendCommitmentSnapshots([
        {
          ...remaining,
          state: "cancelled",
          disposition: { kind: "cancelled", reason, ownerTurnId },
        },
      ]);
    },

    supersedeCommitment(commitmentId, ownerTurnId, reason, replacementCommitmentId) {
      const commitment = requireControlledCommitment(state, commitmentId, ownerTurnId);
      assertNonterminalCommitment(commitment);
      if (!reason.trim()) throw new Error("Superseding a Commitment requires a reason.");
      if (replacementCommitmentId === commitmentId || !state.readCommitment(replacementCommitmentId)) {
        throw new Error("Supersession requires a different existing replacement Commitment.");
      }
      const { condition: _condition, acceptance: _acceptance, ...remaining } = commitment;
      state.appendCommitmentSnapshots([
        {
          ...remaining,
          state: "superseded",
          disposition: {
            kind: "superseded",
            reason,
            ownerTurnId,
            replacementCommitmentId,
          },
        },
      ]);
    },

    observeLeadResponse(ownerTurnId, leadAgentResponse) {
      observeLeadResponse(state, ownerTurnId, leadAgentResponse);
    },

    observeTargetProjectOperationResult(commitmentId, result) {
      recordTargetProjectOperationVerification(state, commitmentId, result, "blocked");
    },

    observeWorkerVerificationResult(workerSessionId, executionAttemptId, result) {
      const worker = requireWorkerSession(state, workerSessionId);
      const attempt = requireCurrentWorkerAttempt(state, worker, executionAttemptId);
      const effect = attempt.effectIntentId
        ? state.readEffectIntent(attempt.effectIntentId)
        : undefined;
      if (
        worker.assignment.readOnly ||
        effect?.kind !== "worker-assignment" ||
        effect.status !== "succeeded" ||
        effect.verificationOperationAttemptId ||
        result.causedByWorker?.workerSessionId !== worker.id ||
        result.causedByWorker.executionAttemptId !== attempt.id ||
        result.causedByWorker.generation !== attempt.generation
      ) {
        throw new Error("Worker Verification result is not attributed to the current settled effect.");
      }
      const commitment = state.readCommitment(worker.assignment.commitmentId);
      if (
        commitment?.condition &&
        commitment.verification?.evidence.some(
          (evidence) => evidence.operationAttemptId === result.operationAttemptId,
        )
      ) {
        state.appendWorkerState({
          effectIntent: { ...effect, verificationOperationAttemptId: result.operationAttemptId },
        });
        return;
      }
      const commitmentSnapshots = buildTargetProjectOperationVerification(
        state,
        worker.assignment.commitmentId,
        result,
        "blocked",
      );
      state.settleWorkerVerification(
        { ...effect, verificationOperationAttemptId: result.operationAttemptId },
        commitmentSnapshots,
      );
    },

    observeLeadTurnFailure(ownerTurnId, reason) {
      for (const commitment of state.readCommitments()) {
        if (commitment.activeOwnerTurnId !== ownerTurnId || commitment.state !== "active") continue;
        state.appendCommitmentSnapshots([
          {
            ...commitment,
            condition: {
              kind: "blocked",
              reason,
              nextAction: "Reconcile the failed Lead turn before continuing this Commitment.",
            },
          },
        ]);
      }
    },

    acceptCommitment(commitmentId, ownerTurnId) {
      const ownerTurnSequence = state.ownerTurnSequence(ownerTurnId);
      if (ownerTurnSequence === undefined) throw new Error(`Unknown Owner turn ${ownerTurnId}.`);
      const commitment = state.readCommitment(commitmentId);
      if (!commitment) throw new Error(`Unknown Commitment ${commitmentId}.`);
      if (commitment.state !== "awaiting-acceptance") {
        throw new Error(`Commitment ${commitmentId} is not awaiting Owner Acceptance.`);
      }
      if (commitment.condition) {
        throw new Error(`Commitment ${commitmentId} must be resumed before Acceptance.`);
      }
      const creationTurnSequence = state.ownerTurnSequence(commitment.createdByOwnerTurnId);
      if (creationTurnSequence === undefined || ownerTurnSequence <= creationTurnSequence) {
        throw new Error("Owner Acceptance must be attributed to a later Owner turn.");
      }
      state.appendCommitmentSnapshots([
        {
          ...commitment,
          state: "accepted",
          acceptance: {
            authority: "owner",
            basis: "owner-verdict",
            ownerTurnId,
            acceptedAt: new Date().toISOString(),
          },
        },
      ]);
    },

    modelCandidateDecision(validation) {
      return Object.values(validation.hardGates).every((status) => status === "passed") &&
        validation.availability === "passed"
        ? "use"
        : "skip";
    },

    modelFailureDecision(failure) {
      if (failure.commitmentMutationApplied || failure.kind === "aborted") return "stop";
      if (failure.kind === "unavailable") return "fallback";
      if (failure.kind === "turn-failed") return "revalidate";
      return "stop";
    },

    startLeadTurnAttempt(input) {
      if (state.ownerTurnSequence(input.ownerTurnId) === undefined) {
        throw new Error(`Unknown Owner turn ${input.ownerTurnId}.`);
      }
      const attempt: LeadTurnAttempt = {
        id: randomUUID(),
        ...input,
        nativeHarness: null,
        status: "started",
      };
      state.appendLeadTurnAttemptSnapshots([attempt]);
      return attempt;
    },

    settleLeadTurnAttempt(attemptId, status, failureKind) {
      const attempt = state.readLeadTurnAttempt(attemptId);
      if (!attempt) throw new Error(`Unknown Lead turn attempt ${attemptId}.`);
      if (attempt.status !== "started") {
        throw new Error(`Lead turn attempt ${attemptId} is already settled.`);
      }
      if (status === "failed" && !failureKind) {
        throw new Error("A failed Lead turn attempt requires a failure kind.");
      }
      state.appendLeadTurnAttemptSnapshots([
        {
          ...attempt,
          status,
          ...(failureKind ? { failureKind } : {}),
        },
      ]);
    },

    delegateReadOnlyWorker(input) {
      if (!input.objective.trim() || !input.prompt.trim()) {
        throw new Error("A Worker assignment requires an objective and prompt.");
      }
      if (
        !input.targetProjectPath.trim() ||
        !input.modelSelection.model.trim() ||
        !input.modelPolicyRevision.trim()
      ) {
        throw new Error("A Worker assignment requires a Target Project and Model Policy.");
      }
      if (input.commitmentId && !state.readCommitment(input.commitmentId)) {
        throw new Error(`Unknown Commitment ${input.commitmentId}.`);
      }
      const workerSessionId = randomUUID();
      const executionAttemptId = randomUUID();
      const workerSession: WorkerSession = {
        id: workerSessionId,
        assignment: {
          objective: input.objective,
          prompt: input.prompt,
          targetProjectPath: input.targetProjectPath,
          readOnly: true,
          modelPolicyRevision: input.modelPolicyRevision,
          ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
        },
        state: "starting",
        currentExecutionAttemptId: executionAttemptId,
      };
      const executionAttempt: WorkerExecutionAttempt = {
        id: executionAttemptId,
        workerSessionId,
        generation: 1,
        modelSelection: input.modelSelection,
        modelPolicyRevision: input.modelPolicyRevision,
        status: "launch-intent-recorded",
      };
      state.startWorkerExecution([workerSession], executionAttempt);
      return { workerSession, executionAttempt };
    },

    delegateEffectfulWorker(input) {
      if (!input.objective.trim() || !input.prompt.trim()) {
        throw new Error("A Worker assignment requires an objective and prompt.");
      }
      if (!input.modelSelection.model.trim() || !input.modelPolicyRevision.trim()) {
        throw new Error("A Worker assignment requires a Model Policy.");
      }
      const configuredPath = state.readOwnerConversation()?.targetProject.path;
      if (!configuredPath || !samePath(configuredPath, input.targetProjectPath)) {
        throw new Error("An effectful Worker requires the active Target Project checkout.");
      }
      const commitment = state.readCommitment(input.commitmentId);
      if (!commitment || commitment.state !== "active" || commitment.condition) {
        throw new Error("An effectful Worker requires one active unblocked Commitment.");
      }
      if (
        !commitment.criteria.some(
          (criterion) =>
            criterion.kind === "target-project-operation" &&
            criterion.operation === input.verification.operation,
        )
      ) {
        throw new Error("The effectful Worker Commitment must declare its Verification operation.");
      }
      if (
        !Number.isInteger(input.timeoutMs) ||
        input.timeoutMs < 1 ||
        !Number.isInteger(input.verification.timeoutMs) ||
        input.verification.timeoutMs < 1
      ) {
        throw new Error("Effectful Worker and Verification timeouts must be positive integers.");
      }
      if (!samePath(input.verification.workingDirectory, configuredPath)) {
        throw new Error("Effectful Worker Verification must run from the active checkout root.");
      }
      if (
        !samePath(input.checkoutIsolation.root, configuredPath) ||
        !/^[0-9a-f]{40,64}$/i.test(input.checkoutIsolation.baselineCommit)
      ) {
        throw new Error("Effectful work requires a proven isolated checkout baseline.");
      }
      if (
        input.targets.length === 0 ||
        input.targets.length > 64 ||
        input.targets.some(
          (target) =>
            !target.trim() ||
            isAbsolute(target) ||
            !isWithin(configuredPath, resolve(configuredPath, target)),
        )
      ) {
        throw new Error("Effectful Worker targets must be bounded checkout-relative paths.");
      }
      const workerSessionId = randomUUID();
      const executionAttemptId = randomUUID();
      const effectIntentId = randomUUID();
      const validatedAt = new Date().toISOString();
      const workerSession: WorkerSession = {
        id: workerSessionId,
        assignment: {
          objective: input.objective,
          prompt: input.prompt,
          targetProjectPath: configuredPath,
          readOnly: false,
          modelPolicyRevision: input.modelPolicyRevision,
          commitmentId: input.commitmentId,
          targets: input.targets,
          effectClasses: ["filesystem-write", "bounded-process-execution"],
          authorizedWriteRoots: [configuredPath],
          timeoutMs: input.timeoutMs,
          costBound: { maximumIncrementalSpendUsd: 0 },
          checkoutIsolation: input.checkoutIsolation,
          authority: {
            kind: "lead-agent-command-authority",
            commitmentId: input.commitmentId,
            validatedAt,
          },
          recoveryConstraint: "reconcile-before-replay",
          verification: input.verification,
        },
        state: "starting",
        currentExecutionAttemptId: executionAttemptId,
      };
      const executionAttempt: WorkerExecutionAttempt = {
        id: executionAttemptId,
        workerSessionId,
        generation: 1,
        modelSelection: input.modelSelection,
        modelPolicyRevision: input.modelPolicyRevision,
        effectIntentId,
        status: "launch-intent-recorded",
      };
      const effectIntent: EffectIntent = {
        id: effectIntentId,
        commitmentId: input.commitmentId,
        kind: "worker-assignment",
        workerSessionId,
        executionAttemptId,
        expectedEffect: `Apply the bounded Worker assignment to ${input.targets.join(", ")}.`,
        authorizedWriteRootKey: normalizedAuthorizedWriteRoot(configuredPath),
        authorization: {
          kind: "lead-agent-command-authority",
          commitmentId: input.commitmentId,
          targetProjectPath: configuredPath,
          validatedAt,
        },
        retryRule: "Reconcile the prior effect before starting any replacement assignment.",
        status: "pending",
      };
      state.startWorkerExecution([workerSession], executionAttempt, effectIntent);
      return { workerSession, executionAttempt };
    },

    observeWorkerProcessStarted(input) {
      const worker = requireWorkerSession(state, input.workerSessionId);
      const attempt = requireCurrentWorkerAttempt(state, worker, input.executionAttemptId);
      if (worker.state !== "starting" || attempt.status !== "dispatching" || !attempt.dispatch) {
        throw new Error(`Worker execution attempt ${attempt.id} has no claimed launch intent.`);
      }
      state.appendWorkerExecutionAttemptSnapshots([
        {
          ...attempt,
          status: "starting",
          process: input.process,
          harnessVersion: input.harnessVersion,
          protocolSchemaSha256: input.protocolSchemaSha256,
        },
      ]);
    },

    claimWorkerLaunch(workerSessionId, executionAttemptId) {
      const worker = requireWorkerSession(state, workerSessionId);
      const attempt = requireCurrentWorkerAttempt(state, worker, executionAttemptId);
      if (worker.state !== "starting" || attempt.status !== "launch-intent-recorded") {
        throw new Error(`Worker execution attempt ${attempt.id} has no launch intent to claim.`);
      }
      const dispatching: WorkerExecutionAttempt = {
        ...attempt,
        status: "dispatching",
        dispatch: { leaseId: randomUUID(), claimedAt: new Date().toISOString() },
      };
      state.appendWorkerExecutionAttemptSnapshots([dispatching]);
      return dispatching;
    },

    claimWorkerEffectDispatch(workerSessionId, executionAttemptId) {
      const worker = requireWorkerSession(state, workerSessionId);
      if (worker.assignment.readOnly) {
        throw new Error("A read-only Worker has no mutating effect to dispatch.");
      }
      const attempt = requireCurrentWorkerAttempt(state, worker, executionAttemptId);
      const effect = attempt.effectIntentId
        ? state.readEffectIntent(attempt.effectIntentId)
        : undefined;
      if (
        attempt.status !== "starting" ||
        effect?.kind !== "worker-assignment" ||
        effect.executionAttemptId !== attempt.id ||
        effect.status !== "pending"
      ) {
        throw new Error(`Worker execution attempt ${attempt.id} has no pending effect to dispatch.`);
      }
      const claimedAt = new Date().toISOString();
      state.appendWorkerState({
        effectIntent: {
          ...effect,
          status: "dispatching",
          lease: {
            claimedAt,
            expiresAt: new Date(Date.now() + worker.assignment.timeoutMs).toISOString(),
          },
        },
      });
    },

    observeWorkerAttemptStarted(input) {
      const worker = requireWorkerSession(state, input.workerSessionId);
      const attempt = requireCurrentWorkerAttempt(state, worker, input.executionAttemptId);
      if (worker.state !== "starting" || attempt.status !== "starting" || !attempt.process) {
        throw new Error(`Worker execution attempt ${attempt.id} is not starting.`);
      }
      if (
        attempt.process.pid !== input.process.pid ||
        attempt.process.startedAt !== input.process.startedAt ||
        attempt.harnessVersion !== input.harnessVersion
      ) {
        throw new Error(`Worker execution attempt ${attempt.id} changed native process identity.`);
      }
      if (!worker.assignment.readOnly) {
        const effect = attempt.effectIntentId
          ? state.readEffectIntent(attempt.effectIntentId)
          : undefined;
        if (
          input.writeIsolation !== "authorized-write-root-enforced" ||
          effect?.status !== "dispatching"
        ) {
          throw new Error(`Worker execution attempt ${attempt.id} lacks proven write isolation.`);
        }
      }
      if (
        input.capabilities.readOnly !== worker.assignment.readOnly ||
        input.capabilities.protocolSchemaSha256 !== attempt.protocolSchemaSha256 ||
        (!worker.assignment.readOnly &&
          input.capabilities.writeIsolation !== "authorized-write-root-enforced")
      ) {
        throw new Error(`Worker execution attempt ${attempt.id} reported incompatible capabilities.`);
      }
      state.appendWorkerState({
        executionAttempt: {
          ...attempt,
          status: "running",
          providerSessionId: input.providerSessionId,
          nativeExecutionId: input.nativeExecutionId,
          process: input.process,
          harnessVersion: input.harnessVersion,
          capabilities: input.capabilities,
        },
        workerSession: { ...worker, state: "running" },
      });
    },

    observeWorkerQuestion(input) {
      const worker = requireWorkerSession(state, input.workerSessionId);
      requireCurrentWorkerAttempt(state, worker, input.executionAttemptId);
      if (worker.state !== "running") {
        throw new Error(`Worker Session ${worker.id} cannot accept a question while ${worker.state}.`);
      }
      if (!input.itemId.trim() || input.questions.length === 0) {
        throw new Error("A Worker question requires an item and answerable questions.");
      }
      const question: WorkerQuestion = {
        id: randomUUID(),
        workerSessionId: worker.id,
        executionAttemptId: input.executionAttemptId,
        providerRequestId: input.providerRequestId,
        itemId: input.itemId,
        questions: input.questions,
        status: "open",
      };
      state.appendWorkerState({
        questions: [question],
        workerSession: { ...worker, state: "waiting-question" },
      });
      return question;
    },

    recordWorkerAnswer(questionId, ownerTurnId, answers) {
      if (state.ownerTurnSequence(ownerTurnId) === undefined) {
        throw new Error(`Unknown Owner turn ${ownerTurnId}.`);
      }
      const question = state.readWorkerQuestion(questionId);
      if (!question) throw new Error(`Unknown Worker question ${questionId}.`);
      if (question.status !== "open") {
        throw new Error(`Worker question ${questionId} was already answered or cancelled.`);
      }
      const expectedQuestionIds = new Set(question.questions.map((item) => item.id));
      const suppliedQuestionIds = Object.keys(answers);
      if (
        suppliedQuestionIds.length !== expectedQuestionIds.size ||
        suppliedQuestionIds.some(
          (id) =>
            !expectedQuestionIds.has(id) ||
            !Array.isArray(answers[id]) ||
            answers[id]!.length === 0 ||
            answers[id]!.some((answer) => !answer.trim()),
        )
      ) {
        throw new Error("Worker answer must address every question with non-empty text.");
      }
      const answered: WorkerQuestion = {
        ...question,
        status: "answer-recorded",
        answer: { ownerTurnId, answers, recordedAt: new Date().toISOString() },
      };
      state.appendWorkerQuestionSnapshots([answered]);
      return answered;
    },

    observeWorkerAnswerDelivered(questionId) {
      const question = state.readWorkerQuestion(questionId);
      if (!question) throw new Error(`Unknown Worker question ${questionId}.`);
      if (question.status !== "answer-recorded") {
        throw new Error(`Worker question ${questionId} has no recorded answer to deliver.`);
      }
      const worker = requireWorkerSession(state, question.workerSessionId);
      requireCurrentWorkerAttempt(state, worker, question.executionAttemptId);
      const delivered: WorkerQuestion = {
        ...question,
        status: "delivered",
        deliveredExecutionAttemptId: question.executionAttemptId,
      };
      if (worker.state === "waiting-question") {
        state.appendWorkerState({
          questions: [delivered],
          workerSession: { ...worker, state: "running" },
        });
      } else {
        state.appendWorkerQuestionSnapshots([delivered]);
      }
    },

    observeWorkerAnswersReplayed(workerSessionId, executionAttemptId, questionIds) {
      const worker = requireWorkerSession(state, workerSessionId);
      const attempt = requireCurrentWorkerAttempt(state, worker, executionAttemptId);
      if (attempt.status !== "running") {
        throw new Error(`Worker execution attempt ${attempt.id} cannot receive retained answers.`);
      }
      const deliveredQuestions: WorkerQuestion[] = [];
      for (const questionId of questionIds) {
        const question = state.readWorkerQuestion(questionId);
        if (
          !question ||
          question.workerSessionId !== worker.id ||
          (question.status !== "answer-recorded" && question.status !== "delivered") ||
          question.deliveredExecutionAttemptId === attempt.id ||
          !question.answer
        ) {
          throw new Error(`Worker question ${questionId} has no retained answer to replay.`);
        }
        deliveredQuestions.push({
          ...question,
          status: "delivered",
          deliveredExecutionAttemptId: attempt.id,
        });
      }
      state.appendWorkerState({ questions: deliveredQuestions });
    },

    requestWorkerCancellation(workerSessionId, ownerTurnId, reason) {
      if (state.ownerTurnSequence(ownerTurnId) === undefined) {
        throw new Error(`Unknown Owner turn ${ownerTurnId}.`);
      }
      if (!reason.trim()) throw new Error("Worker cancellation requires a reason.");
      const worker = requireWorkerSession(state, workerSessionId);
      if (["completed", "blocked", "failed", "cancelled"].includes(worker.state)) {
        throw new Error(`Worker Session ${worker.id} is already terminal.`);
      }
      state.appendWorkerSessionSnapshots([
        {
          ...worker,
          state: "cancellation-requested",
          cancellation: {
            kind: "owner",
            requestedAt: new Date().toISOString(),
            requestedByOwnerTurnId: ownerTurnId,
            reason,
          },
        },
      ]);
    },

    requestWorkerDeadlineExceeded(workerSessionId) {
      const worker = requireWorkerSession(state, workerSessionId);
      if (worker.assignment.readOnly) {
        throw new Error("Only effectful Worker assignments have an orchestrated work deadline.");
      }
      if (["completed", "blocked", "failed", "cancelled"].includes(worker.state)) return;
      state.appendWorkerSessionSnapshots([
        {
          ...worker,
          state: "cancellation-requested",
          cancellation: {
            kind: "deadline",
            requestedAt: new Date().toISOString(),
            reason: `Effectful Worker exceeded its ${worker.assignment.timeoutMs}ms deadline.`,
          },
        },
      ]);
    },

    observeWorkerTerminal(input) {
      const worker = requireWorkerSession(state, input.workerSessionId);
      const attempt = state.readWorkerExecutionAttempt(input.executionAttemptId);
      if (!attempt || attempt.workerSessionId !== worker.id) {
        throw new Error(`Unknown Worker execution attempt ${input.executionAttemptId}.`);
      }
      if (worker.currentExecutionAttemptId !== attempt.id) {
        state.appendWorkerExecutionAttemptSnapshots([
          {
            ...attempt,
            ...(input.output
              ? { output: [attempt.output, input.output].filter(Boolean).join("\n") }
              : {}),
          },
        ]);
        return "stale";
      }
      const harnessName = nativeHarnessName(attempt.modelSelection.nativeHarness);
      if (!worker.assignment.readOnly) {
        const assignment = worker.assignment;
        const effect = attempt.effectIntentId
          ? state.readEffectIntent(attempt.effectIntentId)
          : undefined;
        if (
          effect?.kind !== "worker-assignment" ||
          effect.workerSessionId !== worker.id ||
          effect.executionAttemptId !== attempt.id ||
          (effect.status !== "pending" && effect.status !== "dispatching")
        ) {
          throw new Error(`Effectful Worker execution attempt ${attempt.id} has no open effect.`);
        }
        const artifactPathsValid =
          input.reportedOutcome?.affectedArtifacts.every((artifact) => {
            if (!artifact.trim() || isAbsolute(artifact)) return false;
            const artifactPath = resolve(assignment.targetProjectPath, artifact);
            return (
              isWithin(assignment.targetProjectPath, artifactPath) &&
              assignment.targets.some((target) =>
                isWithin(resolve(assignment.targetProjectPath, target), artifactPath),
              )
            );
          }) ?? false;
        const observedChanges = input.observedChanges ?? [];
        const observedChangesValid =
          observedChanges.length > 0 &&
          observedChanges.every((artifact) => {
            if (!artifact.trim() || isAbsolute(artifact)) return false;
            const artifactPath = resolve(assignment.targetProjectPath, artifact);
            return (
              isWithin(assignment.targetProjectPath, artifactPath) &&
              assignment.targets.some((target) =>
                isWithin(resolve(assignment.targetProjectPath, target), artifactPath),
              )
            );
          });
        const reportedArtifactsMatch =
          artifactPathsValid &&
          observedChanges.length === input.reportedOutcome?.affectedArtifacts.length &&
          observedChanges.every((path) => input.reportedOutcome?.affectedArtifacts.includes(path));
        const deadlineExceeded = worker.cancellation?.kind === "deadline";
        const completedSafely =
          effect.status === "dispatching" &&
          input.status === "completed" &&
          input.processGone &&
          input.reportedOutcome?.status === "completed" &&
          !input.reportedOutcome.unresolvedUncertainty &&
          observedChangesValid &&
          reportedArtifactsMatch &&
          !deadlineExceeded;
        const effectStatus = completedSafely
          ? "succeeded"
          : effect.status === "pending"
            ? "rejected"
            : "unknown";
        const timedOut = deadlineExceeded;
        const cancelled =
          !timedOut && input.status === "interrupted" && worker.state === "cancellation-requested";
        const uncertainty = completedSafely
          ? undefined
          : effectStatus === "unknown"
            ? input.reportedOutcome?.unresolvedUncertainty ??
              input.detail ??
              (!input.processGone
                ? "The recorded native process is not proven gone."
                : deadlineExceeded
                  ? "The Worker completed after its durable assignment deadline expired."
                : !observedChangesValid
                  ? "No bounded Target Project change was observed against the assignment baseline."
                  : !reportedArtifactsMatch
                    ? "The Worker report did not match the observed Target Project changes."
                  : "The dispatched Worker effect could not be proven settled.")
            : input.detail ?? "The Worker failed before its effect was dispatched.";
        const outcome: WorkerOutcome = {
          status: completedSafely
            ? "completed"
            : timedOut
              ? "timed-out"
              : cancelled
                ? "cancelled"
                : "failed",
          summary:
            input.reportedOutcome?.summary ||
            input.output?.trim() ||
            input.detail ||
            `${harnessName} turn ended ${input.status}.`,
          affectedArtifacts: observedChanges,
          materialCommands: input.materialCommands ?? [],
          verificationResults: [
            ...(input.reportedOutcome?.verificationResults ?? []),
            `${harnessName} native turn ${attempt.nativeExecutionId ?? attempt.id} ended ${input.status}.`,
            ...(input.processGone ? ["The recorded native process is proven gone."] : []),
            ...(observedChanges.length
              ? [`Observed ${observedChanges.length} change(s) against the isolated checkout baseline.`]
              : []),
          ],
          ...(uncertainty ? { unresolvedUncertainty: uncertainty } : {}),
          evidence: {
            ...(attempt.providerSessionId ? { providerSessionId: attempt.providerSessionId } : {}),
            ...(attempt.nativeExecutionId ? { nativeExecutionId: attempt.nativeExecutionId } : {}),
            ...(attempt.harnessVersion ? { harnessVersion: attempt.harnessVersion } : {}),
            baselineCommit: assignment.checkoutIsolation.baselineCommit,
          },
        };
        const settledQuestions = state
          .readWorkerQuestions()
          .filter(
            (question) =>
              question.executionAttemptId === attempt.id &&
              (question.status === "open" || question.status === "answer-recorded"),
          )
          .map((question) => ({ ...question, status: "cancelled" as const }));
        state.appendWorkerState({
          executionAttempt: {
            ...attempt,
            status: completedSafely
              ? "completed"
              : timedOut
                ? "timed-out"
                : cancelled
                  ? "cancelled"
                  : "failed",
            ...(input.output ? { output: input.output } : {}),
            ...(input.detail ? { failure: input.detail } : {}),
            outcome,
          },
          questions: settledQuestions,
          workerSession: {
            ...worker,
            state: completedSafely
              ? "completed"
              : effectStatus === "unknown"
                ? "reconciling"
                : "failed",
            outcome,
          },
          effectIntent: { ...effect, status: effectStatus },
        });
        return "settled";
      }
      const cancelled = input.status === "interrupted" && worker.state === "cancellation-requested";
      if (cancelled && !input.processGone) {
        throw new Error("Worker cancellation remains unsettled until its process is proven gone.");
      }
      const contradictoryReadOnlyReport = Boolean(input.reportedOutcome?.affectedArtifacts.length);
      const missingReport = input.status === "completed" && !input.reportedOutcome;
      const reportedBlocked = input.reportedOutcome?.status === "blocked";
      const attemptStatus = cancelled
        ? "cancelled"
        : input.status !== "completed" || missingReport || contradictoryReadOnlyReport
          ? "failed"
          : reportedBlocked
            ? "blocked"
            : "completed";
      const outcome: WorkerOutcome = {
        status: cancelled
          ? "cancelled"
          : attemptStatus === "completed"
            ? "completed"
            : attemptStatus === "blocked"
              ? "blocked"
              : "failed",
        summary:
          input.reportedOutcome?.summary ||
          input.output?.trim() ||
          input.detail ||
          `${harnessName} turn ended ${input.status}.`,
        affectedArtifacts: input.reportedOutcome?.affectedArtifacts ?? [],
        materialCommands: input.materialCommands ?? [],
        verificationResults: [
          ...(input.reportedOutcome?.verificationResults ?? []),
          `${harnessName} native turn ${attempt.nativeExecutionId ?? attempt.id} ended ${input.status}.`,
          ...(input.processGone ? ["The recorded native process is proven gone."] : []),
        ],
        ...(input.reportedOutcome?.unresolvedUncertainty ||
        input.status === "failed" ||
        !input.processGone ||
        missingReport ||
        contradictoryReadOnlyReport
          ? {
              unresolvedUncertainty:
                (contradictoryReadOnlyReport
                  ? "A read-only Worker reported affected artifacts."
                  : undefined) ??
                (missingReport ? "The Worker omitted its required structured outcome." : undefined) ??
                input.reportedOutcome?.unresolvedUncertainty ??
                input.detail ??
                (!input.processGone ? "The recorded native process is not proven gone." : "Worker failed."),
            }
          : {}),
        evidence: {
          ...(attempt.providerSessionId ? { providerSessionId: attempt.providerSessionId } : {}),
          ...(attempt.nativeExecutionId ? { nativeExecutionId: attempt.nativeExecutionId } : {}),
          ...(attempt.harnessVersion ? { harnessVersion: attempt.harnessVersion } : {}),
        },
      };
      const settledQuestions: WorkerQuestion[] = [];
      for (const question of state.readWorkerQuestions()) {
        if (
          question.executionAttemptId === attempt.id &&
          (question.status === "open" || question.status === "answer-recorded")
        ) {
          settledQuestions.push({ ...question, status: "cancelled" });
        }
      }
      state.appendWorkerState({
        executionAttempt: {
          ...attempt,
          status: attemptStatus,
          ...(input.output ? { output: input.output } : {}),
          ...(input.detail ? { failure: input.detail } : {}),
          outcome,
        },
        questions: settledQuestions,
        workerSession: {
          ...worker,
          state: cancelled
            ? "cancelled"
            : attemptStatus === "completed"
              ? "completed"
              : attemptStatus === "blocked"
                ? "blocked"
                : "failed",
          outcome,
        },
      });
      return "settled";
    },

    recordWorkerContinuityLoss(workerSessionId, executionAttemptId, reason) {
      recordWorkerContinuityLoss(state, workerSessionId, executionAttemptId, reason);
    },

    reconcileInterruptedWorkers(reason) {
      for (const worker of state.readWorkerSessions()) {
        if (["completed", "blocked", "failed", "cancelled", "cancellation-requested"].includes(worker.state)) {
          continue;
        }
        recordWorkerContinuityLoss(
          state,
          worker.id,
          worker.currentExecutionAttemptId,
          reason,
        );
      }
    },

    recoverWorker(workerSessionId, processGone) {
      const worker = requireWorkerSession(state, workerSessionId);
      const previousAttempt = requireCurrentWorkerAttempt(
        state,
        worker,
        worker.currentExecutionAttemptId,
      );
      if (worker.state === "cancellation-requested") {
        if (!processGone) return { kind: "blocked" };
        this.observeWorkerTerminal({
          workerSessionId: worker.id,
          executionAttemptId: previousAttempt.id,
          status: "interrupted",
          processGone: true,
          detail: "Cancellation completed during continuity reconciliation.",
        });
        return { kind: "settled" };
      }
      if (!worker.assignment.readOnly) {
        if (!processGone) return { kind: "blocked" };
        this.observeWorkerTerminal({
          workerSessionId: worker.id,
          executionAttemptId: previousAttempt.id,
          status: "failed",
          processGone: true,
          detail: "Effectful Worker continuity was lost; replay is forbidden.",
        });
        const effect = previousAttempt.effectIntentId
          ? state.readEffectIntent(previousAttempt.effectIntentId)
          : undefined;
        return { kind: effect?.status === "unknown" ? "blocked" : "settled" };
      }
      if (["completed", "blocked", "failed", "cancelled"].includes(worker.state)) {
        throw new Error(`Worker Session ${worker.id} is already terminal.`);
      }
      if (previousAttempt.status !== "continuity-lost") {
        throw new Error(`Worker Session ${worker.id} has no recorded continuity loss.`);
      }
      if (previousAttempt.generation >= 3) {
        blockWorkerRecovery(
          state,
          worker,
          previousAttempt,
          previousAttempt.failure ??
            `${nativeHarnessName(previousAttempt.modelSelection.nativeHarness)} continuity remained unavailable.`,
        );
        return { kind: "blocked" };
      }
      const executionAttempt: WorkerExecutionAttempt = {
        id: randomUUID(),
        workerSessionId: worker.id,
        generation: previousAttempt.generation + 1,
        modelSelection: previousAttempt.modelSelection,
        modelPolicyRevision: previousAttempt.modelPolicyRevision,
        status: "launch-intent-recorded",
      };
      const reconciling: WorkerSession = { ...worker, state: "reconciling" };
      const restarting: WorkerSession = {
        ...reconciling,
        state: "starting",
        currentExecutionAttemptId: executionAttempt.id,
      };
      state.startWorkerExecution([reconciling, restarting], executionAttempt);
      return { kind: "restart", workerSession: restarting, executionAttempt };
    },

  };
}

export function assertValidatedLeadModelPolicy(
  policy: LeadModelPolicy,
  validations: readonly ModelCandidateValidation[],
): void {
  if (!policy.revision.trim()) throw new Error("Model Policy revision is required.");
  const candidates = [policy.default, ...policy.fallbacks];
  if (
    validations.length !== candidates.length ||
    candidates.some(
      (candidate, index) =>
        !sameModelSelection(candidate, validations[index]?.modelSelection) ||
        !sameRequirements(policy.requirements, validations[index]?.requirements) ||
        Object.values(validations[index]?.hardGates ?? {}).some((status) => status !== "passed"),
    )
  ) {
    throw new Error("Every Lead Model candidate must pass validation before policy activation.");
  }
}

function sameRequirements(
  left: LeadModelRequirements,
  right: LeadModelRequirements | undefined,
): boolean {
  return Boolean(right) && JSON.stringify(left) === JSON.stringify(right);
}

function nativeHarnessName(harness: WorkerModelSelection["nativeHarness"]): string {
  return harness === "codex" ? "Codex" : harness === "claude" ? "Claude" : "Copilot";
}

function observeLeadResponse(
  state: OrchestrationState,
  ownerTurnId: string,
  leadAgentResponse: string,
): void {
  const commitments = state.readCommitments().filter(
    (commitment) =>
      commitment.activeOwnerTurnId === ownerTurnId &&
      commitment.state === "active" &&
      !commitment.condition,
  );
  for (const commitment of commitments) {
    const { condition: _condition, ...unconditioned } = commitment;
    const verifying: Commitment = { ...unconditioned, state: "verifying" };
    const evidence = commitment.criteria.map((criterion) => ({
      id: randomUUID(),
      criterionId: criterion.id,
      description:
        criterion.kind === "response-includes"
          ? leadAgentResponse.includes(criterion.expectedText)
            ? `The Lead Agent response includes ${JSON.stringify(criterion.expectedText)}.`
            : `The Lead Agent response does not include ${JSON.stringify(criterion.expectedText)}.`
          : criterion.kind === "owner-judgment" && leadAgentResponse.trim()
            ? "The Lead Agent response was presented for Owner judgment."
            : criterion.kind === "owner-judgment"
              ? "No Lead Agent response was presented for Owner judgment."
              : "No successful Target Project operation result was observed.",
      source: "lead-agent-response" as const,
    }));
    const passed = commitment.criteria.every((criterion) =>
      criterion.kind === "owner-judgment"
        ? Boolean(leadAgentResponse.trim())
        : criterion.kind === "response-includes"
          ? leadAgentResponse.includes(criterion.expectedText)
          : false,
    );
    const verification = {
      passed,
      verifiedAt: new Date().toISOString(),
      evidence,
    };
    let settled: Commitment;
    if (!passed) {
      settled = {
        ...verifying,
        state: "active",
        verification,
        condition: {
          kind: "blocked",
          reason: "The observed Lead Agent response did not satisfy every criterion.",
          nextAction: "Produce a new response from a changed hypothesis and verify it.",
        },
      };
    } else if (commitment.criteria.some((criterion) => criterion.kind === "owner-judgment")) {
      settled = { ...verifying, state: "awaiting-acceptance", verification };
    } else {
      settled = {
        ...verifying,
        state: "accepted",
        verification,
        acceptance: {
          authority: "lead-agent",
          basis: "objective-criteria",
          acceptedAt: new Date().toISOString(),
        },
      };
    }
    state.appendCommitmentSnapshots([verifying, settled]);
  }
}

function recordTargetProjectOperationVerification(
  state: OrchestrationState,
  commitmentId: string,
  result: TargetProjectOperationResult,
  failureCondition: "blocked" | "reconciling",
): void {
  state.appendCommitmentSnapshots(
    buildTargetProjectOperationVerification(state, commitmentId, result, failureCondition),
  );
}

function buildTargetProjectOperationVerification(
  state: OrchestrationState,
  commitmentId: string,
  result: TargetProjectOperationResult,
  failureCondition: "blocked" | "reconciling",
): Commitment[] {
  const commitment = state.readCommitment(commitmentId);
  if (!commitment) throw new Error(`Unknown Commitment ${commitmentId}.`);
  if (commitment.state !== "active" || commitment.condition) {
    throw new Error(`Commitment ${commitmentId} cannot verify an operation result.`);
  }
  if (result.commitmentId !== commitmentId) {
    throw new Error("Target Project operation result belongs to a different Commitment.");
  }
  const attempt = state.readTargetProjectOperationAttempt(result.operationAttemptId);
  const effectIntent = state.readEffectIntent(result.effectIntentId);
  const expectedEffectStatus = result.status === "succeeded"
    ? "succeeded"
    : result.status === "rejected" || result.status === "unavailable"
      ? "rejected"
      : "unknown";
  if (
    !attempt?.result ||
    attempt.commitmentId !== commitmentId ||
    attempt.effectIntentId !== result.effectIntentId ||
    JSON.stringify(attempt.result) !== JSON.stringify(result) ||
    effectIntent?.kind !== "target-project-operation" ||
    effectIntent?.operationAttemptId !== attempt.id ||
    effectIntent.commitmentId !== commitmentId ||
    effectIntent.status !== expectedEffectStatus
  ) {
    throw new Error("Target Project operation result is not the current attributed durable fact.");
  }
  const operationCriteria = commitment.criteria.filter(
    (criterion) => criterion.kind === "target-project-operation",
  );
  if (
    operationCriteria.length !== commitment.criteria.length ||
    operationCriteria.some((criterion) => criterion.operation !== result.operation)
  ) {
    throw new Error("Commitment criteria do not match the Target Project operation result.");
  }
  const verifying: Commitment = { ...commitment, state: "verifying" };
  const passed = result.status === "succeeded" && result.uncertainty === null;
  const verification = {
    passed,
    verifiedAt: new Date().toISOString(),
    evidence: operationCriteria.map((criterion) => ({
      id: randomUUID(),
      criterionId: criterion.id,
      description: passed
        ? `Target Project operation ${result.operation} succeeded without unresolved uncertainty.`
        : result.uncertainty
          ? `Target Project operation ${result.operation} ended ${result.status} with unresolved uncertainty.`
          : `Target Project operation ${result.operation} was ${result.status} before effect dispatch.`,
      source: "target-project-operation-result" as const,
      operationAttemptId: result.operationAttemptId,
    })),
  };
  const settled: Commitment = passed
    ? {
        ...verifying,
        state: "accepted",
        verification,
        acceptance: {
          authority: "lead-agent",
          basis: "objective-criteria",
          acceptedAt: new Date().toISOString(),
        },
      }
    : {
        ...verifying,
        state: "active",
        verification,
        condition: {
          kind: failureCondition,
          reason: failureCondition === "reconciling"
            ? "Host restart left the Target Project operation effect uncertain."
            : "The Target Project operation did not produce a certain successful result.",
          nextAction: result.uncertainty?.nextAction ?? "Diagnose the failed operation before retrying.",
        },
      };
  return [verifying, settled];
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function normalizedAuthorizedWriteRoot(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validateCommitmentDraft(draft: CommitmentDraft): void {
  if (!draft.outcome.trim()) throw new Error("A Commitment outcome is required.");
  if (draft.criteria.length === 0) throw new Error("A Commitment requires criteria.");
  for (const criterion of draft.criteria) {
    if (criterion.kind === "response-includes") {
      if (!criterion.description.trim()) {
        throw new Error("A Commitment criterion description is required.");
      }
      if (!criterion.expectedText) {
        throw new Error("An objective response criterion requires expected text.");
      }
    }
  }
  const hasOperationCriterion = draft.criteria.some(
    (criterion) => criterion.kind === "target-project-operation",
  );
  if (hasOperationCriterion && draft.criteria.some((criterion) => criterion.kind !== "target-project-operation")) {
    throw new Error("A Target Project operation Commitment cannot mix response criteria.");
  }
}

function requireControlledCommitment(
  state: OrchestrationState,
  commitmentId: string,
  ownerTurnId: string,
): Commitment {
  if (state.ownerTurnSequence(ownerTurnId) === undefined) {
    throw new Error(`Unknown Owner turn ${ownerTurnId}.`);
  }
  const commitment = state.readCommitment(commitmentId);
  if (!commitment) throw new Error(`Unknown Commitment ${commitmentId}.`);
  return commitment;
}

function assertNonterminalCommitment(commitment: Commitment): void {
  if (["accepted", "cancelled", "superseded"].includes(commitment.state)) {
    throw new Error(`Commitment ${commitment.id} is already terminal.`);
  }
}

function requireWorkerSession(state: OrchestrationState, workerSessionId: string): WorkerSession {
  const worker = state.readWorkerSession(workerSessionId);
  if (!worker) throw new Error(`Unknown Worker Session ${workerSessionId}.`);
  return worker;
}

function requireCurrentWorkerAttempt(
  state: OrchestrationState,
  worker: WorkerSession,
  executionAttemptId: string,
): WorkerExecutionAttempt {
  if (worker.currentExecutionAttemptId !== executionAttemptId) {
    throw new Error(`Worker output belongs to stale execution attempt ${executionAttemptId}.`);
  }
  const attempt = state.readWorkerExecutionAttempt(executionAttemptId);
  if (!attempt || attempt.workerSessionId !== worker.id) {
    throw new Error(`Unknown Worker execution attempt ${executionAttemptId}.`);
  }
  return attempt;
}

function recordWorkerContinuityLoss(
  state: OrchestrationState,
  workerSessionId: string,
  executionAttemptId: string,
  reason: string,
): void {
  if (!reason.trim()) throw new Error("Worker continuity loss requires a reason.");
  const worker = requireWorkerSession(state, workerSessionId);
  const attempt = requireCurrentWorkerAttempt(state, worker, executionAttemptId);
  const lostAttempt =
    attempt.status === "continuity-lost"
      ? undefined
      : { ...attempt, status: "continuity-lost" as const, failure: reason };
  const reconcilingWorker =
    worker.state === "reconciling" || worker.state === "cancellation-requested"
      ? undefined
      : { ...worker, state: "reconciling" as const };
  state.appendWorkerState({
    ...(lostAttempt ? { executionAttempt: lostAttempt } : {}),
    ...(reconcilingWorker ? { workerSession: reconcilingWorker } : {}),
  });
}

function blockWorkerRecovery(
  state: OrchestrationState,
  worker: WorkerSession,
  attempt: WorkerExecutionAttempt,
  reason: string,
): void {
  const outcome: WorkerOutcome = {
    status: "blocked",
    summary: "Automatic read-only continuity recovery exhausted its bounded attempts.",
    affectedArtifacts: [],
    materialCommands: [],
    verificationResults: [],
    unresolvedUncertainty: reason,
    evidence: {
      ...(attempt.providerSessionId ? { providerSessionId: attempt.providerSessionId } : {}),
      ...(attempt.nativeExecutionId ? { nativeExecutionId: attempt.nativeExecutionId } : {}),
      ...(attempt.harnessVersion ? { harnessVersion: attempt.harnessVersion } : {}),
    },
  };
  state.appendWorkerState({
    executionAttempt: { ...attempt, status: "blocked", failure: reason, outcome },
    workerSession: { ...worker, state: "blocked", outcome },
  });
}

function sameModelSelection(left: ModelSelection, right: ModelSelection | undefined): boolean {
  if (!right) return false;
  if (left.provider !== right.provider || left.model !== right.model || left.api !== right.api) {
    return false;
  }
  return (
    left.api !== "openai-completions" ||
    (right.api === "openai-completions" && left.baseUrl === right.baseUrl)
  );
}
