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

export type ReviewReason =
  | "public-module"
  | "authorization"
  | "data"
  | "deployment"
  | "self-repair"
  | "objective-check-gap";

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
    ownerAttention?:
      | "owner-reserved-decision"
      | "recovery-exhausted"
      | "trusted-base-loss"
      | "mission-critical-impairment";
    ownerAttentionCause?: {
      kind: "worker-recovery-exhausted";
      workerSessionId: string;
    };
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
  review?: {
    required: true;
    reasons: ReviewReason[];
    status: "pending" | "awaiting-adjudication" | "passed" | "changes-requested";
    reviewerWorkerSessionId?: string;
    implementationWorkerSessionId?: string;
    findings: ReviewFinding[];
  };
};

export type CommitmentDraft = {
  outcome: string;
  review?: {
    required: true;
    reasons: ReviewReason[];
  };
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
  ownerAttention?: {
    kind: "recovery-exhausted";
    reason: string;
    nextAction: string;
  };
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
    coordination?:
      | { role: "implementer"; repairOfReviewFindingIds?: string[] }
      | { role: "reviewer"; reviewOfWorkerSessionId: string }
      | { role: "recovery"; recoveryOfWorkerSessionId: string; reason: string };
};

export type ReviewFinding = {
  id: string;
  basis: "criterion" | "evidence" | "risk";
  disposition: "must-fix" | "follow-up";
  summary: string;
  evidence: string;
  leadDisposition?: {
    authority: "lead-agent";
    kind: "must-fix" | "documented-exception" | "follow-up";
    rationale: string;
    decidedAt: string;
  };
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
  reviewFindings?: ReviewFinding[];
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
  reviewFindings?: Array<Omit<ReviewFinding, "id">>;
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
  ownerAttention?: {
    kind: "owner-reserved-decision";
    reason: string;
  };
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

export type StandingOrderEffectClass =
  | "product-decision"
  | "prioritization"
  | "test"
  | "merge"
  | "deploy"
  | "update"
  | "restart"
  | "self-repair";

export type StandingOrder = {
  id: string;
  title: string;
  instruction: string;
  commitmentIds: string[];
  effectClasses: StandingOrderEffectClass[];
  targets: string[];
  allowIrreversibleEffects: boolean;
  allowExternallyBindingEffects: boolean;
  maximumIncrementalSpendUsd: number;
  validFrom: string;
  validUntil: string;
  createdByOwnerTurnId: string;
  ownerInstructionQuote: string;
  state: "active" | "revoked";
  revocation?: {
    ownerTurnId: string;
    reason: string;
    revokedAt: string;
  };
};

export type StandingOrderDraft = Pick<
  StandingOrder,
  | "title"
  | "instruction"
  | "commitmentIds"
  | "effectClasses"
  | "targets"
  | "allowIrreversibleEffects"
  | "allowExternallyBindingEffects"
  | "maximumIncrementalSpendUsd"
  | "validUntil"
  | "ownerInstructionQuote"
>;

export type ActingAuthorityEvent = {
  id: string;
  kind: "decision" | "effect" | "exception" | "risk" | "uncertainty";
  commitmentId: string;
  summary: string;
  evidence: string[];
  recordedAt: string;
  effect?: {
    effectClass: StandingOrderEffectClass;
    target: string;
    reversible: boolean;
    externallyBinding: boolean;
    incrementalSpendUsd: number;
    standingOrderId: string;
    effectIntentId: string;
  };
  decision?: {
    decisionClass: "product-decision" | "prioritization";
    target: string;
    standingOrderId: string;
  };
};

export type ActingAuthorityHandoff = {
  preparedForOwnerTurnId: string;
  preparedAt: string;
  decisions: string[];
  effects: string[];
  exceptions: string[];
  risks: string[];
  uncertainty: string[];
  deliveredAt?: string;
};

export type ActingAuthorityEffectRequest = {
  actingAuthorityId: string;
  commitmentId: string;
  effectClass: StandingOrderEffectClass;
  target: string;
  reversible: boolean;
  externallyBinding: boolean;
  incrementalSpendUsd: number;
};

export type ActingAuthorityEffectAuthorization = ActingAuthorityEffectRequest & {
  id: string;
  standingOrderId: string;
  authorizedAt: string;
};

export type ActingAuthority = {
  id: string;
  state: "active" | "handoff-pending" | "ended";
  commitmentIds: string[];
  standingOrderIds: string[];
  startedByOwnerTurnId: string;
  ownerInstructionQuote: string;
  startedAt: string;
  events: ActingAuthorityEvent[];
  effectAuthorizations: ActingAuthorityEffectAuthorization[];
  handoff?: ActingAuthorityHandoff;
};

export type CoordinationMessage = {
  id: string;
  fromWorkerSessionId: string;
  toWorkerSessionId: string;
  commitmentId: string;
  kind:
    | "review-request"
    | "review-finding"
    | "evidence"
    | "blocker"
    | "factual-question"
    | "factual-answer"
    | "completion";
  summary: string;
  evidence: string[];
  reviewFindingId?: string;
  recordedAt: string;
};

export interface OrchestrationState {
  readOwnerConversation(): OwnerConfiguration | undefined;
  ownerMessage(ownerTurnId: string): string | undefined;
  latestOwnerTurnId(): string | undefined;
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
  readStandingOrder(standingOrderId: string): StandingOrder | undefined;
  readStandingOrders(): StandingOrder[];
  appendStandingOrderSnapshots(snapshots: StandingOrder[]): void;
  readActingAuthority(actingAuthorityId: string): ActingAuthority | undefined;
  readActingAuthorities(): ActingAuthority[];
  appendActingAuthoritySnapshots(snapshots: ActingAuthority[]): void;
  appendCoordinationMessage(message: CoordinationMessage): void;
  readCoordinationMessages(): CoordinationMessage[];
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
  standingOrdersView(): StandingOrder[];
  actingAuthorityView(): ActingAuthority | undefined;
  recordStandingOrder(ownerTurnId: string, draft: StandingOrderDraft): StandingOrder;
  revokeStandingOrder(standingOrderId: string, ownerTurnId: string, reason: string): void;
  beginActingAuthority(ownerTurnId: string, input: {
    commitmentIds: string[];
    standingOrderIds: string[];
    ownerInstructionQuote: string;
  }): ActingAuthority;
  authorizeActingAuthorityEffect(
    input: ActingAuthorityEffectRequest,
  ): ActingAuthorityEffectAuthorization;
  recordActingAuthorityEvent(
    actingAuthorityId: string,
    input: Omit<ActingAuthorityEvent, "id" | "recordedAt" | "effect" | "decision"> & {
      effect?: Omit<NonNullable<ActingAuthorityEvent["effect"]>, "standingOrderId">;
      decision?: Omit<NonNullable<ActingAuthorityEvent["decision"]>, "standingOrderId">;
    },
  ): ActingAuthorityEvent;
  prepareActingAuthorityHandoff(
    actingAuthorityId: string,
    ownerTurnId: string,
  ): ActingAuthorityHandoff;
  observeActingAuthorityHandoffDelivered(
    actingAuthorityId: string,
    ownerTurnId: string,
    leadAgentResponse: string,
  ): void;
  coordinationMessagesView(): CoordinationMessage[];
  recordCoordinationMessage(input: Omit<CoordinationMessage, "id" | "recordedAt">): CoordinationMessage;
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
  recordCommitmentOwnerAttention(
    commitmentId: string,
    input: {
      kind: NonNullable<Commitment["condition"]>["ownerAttention"];
      reason: string;
      nextAction: string;
      cause?: NonNullable<Commitment["condition"]>["ownerAttentionCause"];
    },
  ): Commitment;
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
    recoveryOfWorkerSessionId?: string;
    recoveryReason?: string;
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
    actingAuthorityEffectAuthorizationId?: string;
  }): { workerSession: WorkerSession; executionAttempt: WorkerExecutionAttempt };
  delegateReviewWorker(input: {
    implementationWorkerSessionId: string;
    prompt: string;
    modelSelection: WorkerModelSelection;
    modelPolicyRevision: string;
  }): { workerSession: WorkerSession; executionAttempt: WorkerExecutionAttempt };
  adjudicateReview(
    commitmentId: string,
    decisions: Array<{
      reviewFindingId: string;
      disposition: NonNullable<ReviewFinding["leadDisposition"]>["kind"];
      rationale: string;
    }>,
  ): void;
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
  reserveWorkerQuestionForOwner(questionId: string, reason: string): WorkerQuestion;
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
    standingOrdersView() {
      return state.readStandingOrders();
    },

    actingAuthorityView() {
      return state.readActingAuthorities().at(-1);
    },

    coordinationMessagesView() {
      return state.readCoordinationMessages();
    },

    recordCoordinationMessage(input) {
      return recordCoordinationMessage(state, input);
    },

    recordStandingOrder(ownerTurnId, draft) {
      const ownerInstruction = requireExplicitCurrentOwnerInstruction(
        state,
        ownerTurnId,
        draft.ownerInstructionQuote,
      );
      validateStandingOrderDraft(state, draft);
      validateStandingOrderOwnerInstruction(draft, ownerInstruction);
      const now = new Date().toISOString();
      const standingOrder: StandingOrder = {
        id: randomUUID(),
        ...draft,
        validFrom: now,
        createdByOwnerTurnId: ownerTurnId,
        state: "active",
      };
      state.appendStandingOrderSnapshots([standingOrder]);
      return standingOrder;
    },

    revokeStandingOrder(standingOrderId, ownerTurnId, reason) {
      requireCurrentOwnerTurn(state, ownerTurnId);
      if (!reason.trim()) throw new Error("Standing Order revocation requires a reason.");
      const standingOrder = state.readStandingOrder(standingOrderId);
      if (!standingOrder) throw new Error(`Unknown Standing Order ${standingOrderId}.`);
      if (standingOrder.state !== "active") {
        throw new Error(`Standing Order ${standingOrderId} is already revoked.`);
      }
      state.appendStandingOrderSnapshots([{
        ...standingOrder,
        state: "revoked",
        revocation: {
          ownerTurnId,
          reason,
          revokedAt: new Date().toISOString(),
        },
      }]);
    },

    beginActingAuthority(ownerTurnId, input) {
      const ownerInstruction = requireExplicitCurrentOwnerInstruction(
        state,
        ownerTurnId,
        input.ownerInstructionQuote,
      );
      if (!/\b(begin|start|activate)\s+(?:the\s+)?acting authority\b/i.test(ownerInstruction)) {
        throw new Error("Acting Authority requires an affirmative current Owner instruction to begin.");
      }
      if (/\b(do not|don't|never|not)\s+(?:begin|start|activate)\s+(?:the\s+)?acting authority\b/i.test(ownerInstruction)) {
        throw new Error("A negated Owner instruction cannot begin Acting Authority.");
      }
      if (input.commitmentIds.length === 0 || input.standingOrderIds.length === 0) {
        throw new Error("Acting Authority requires bounded Commitments and active Standing Orders.");
      }
      const current = state.readActingAuthorities().at(-1);
      if (current && current.state !== "ended") {
        throw new Error(`Acting Authority ${current.id} has not returned command.`);
      }
      const commitments = input.commitmentIds.map((id) => {
        const commitment = state.readCommitment(id);
        if (!commitment) throw new Error(`Unknown Commitment ${id}.`);
        if (["accepted", "cancelled", "superseded"].includes(commitment.state)) {
          throw new Error(`Acting Authority requires a nonterminal Commitment; ${id} is terminal.`);
        }
        return commitment;
      });
      const now = Date.now();
      const orders = input.standingOrderIds.map((id) => {
        const order = state.readStandingOrder(id);
        if (!order || order.state !== "active" || Date.parse(order.validUntil) <= now) {
          throw new Error(`Acting Authority requires active Standing Order ${id}.`);
        }
        return order;
      });
      for (const commitment of commitments) {
        if (!orders.some((order) => order.commitmentIds.includes(commitment.id))) {
          throw new Error(`No active Standing Order covers Commitment ${commitment.id}.`);
        }
      }
      const actingAuthority: ActingAuthority = {
        id: randomUUID(),
        state: "active",
        commitmentIds: [...new Set(input.commitmentIds)],
        standingOrderIds: [...new Set(input.standingOrderIds)],
        startedByOwnerTurnId: ownerTurnId,
        ownerInstructionQuote: input.ownerInstructionQuote,
        startedAt: new Date().toISOString(),
        events: [],
        effectAuthorizations: [],
      };
      state.appendActingAuthoritySnapshots([actingAuthority]);
      return actingAuthority;
    },

    authorizeActingAuthorityEffect(input) {
      const actingAuthority = requireActiveActingAuthority(state, input.actingAuthorityId);
      if (!actingAuthority.commitmentIds.includes(input.commitmentId)) {
        throw new Error("Acting Authority cannot authorize an effect outside its bounded Commitments.");
      }
      if (!Number.isFinite(input.incrementalSpendUsd) || input.incrementalSpendUsd < 0) {
        throw new Error("Acting Authority effect authorization requires finite nonnegative cost.");
      }
      const standingOrder = applicableStandingOrder(
        state,
        actingAuthority,
        input.commitmentId,
        input.effectClass,
        input.target,
        input,
      );
      if (!standingOrder) {
        throw new Error("The effect dispatch has no applicable active Standing Order.");
      }
      const authorization: ActingAuthorityEffectAuthorization = {
        id: randomUUID(),
        ...input,
        standingOrderId: standingOrder.id,
        authorizedAt: new Date().toISOString(),
      };
      state.appendActingAuthoritySnapshots([{
        ...actingAuthority,
        effectAuthorizations: [...(actingAuthority.effectAuthorizations ?? []), authorization],
      }]);
      return authorization;
    },

    recordActingAuthorityEvent(actingAuthorityId, input) {
      const actingAuthority = requireActiveActingAuthority(state, actingAuthorityId);
      if (!actingAuthority.commitmentIds.includes(input.commitmentId)) {
        throw new Error("Acting Authority cannot expand beyond its bounded Commitments.");
      }
      if (!input.summary.trim() || input.evidence.length === 0 || input.evidence.some((item) => !item.trim())) {
        throw new Error("An Acting Authority event requires a summary and concrete evidence.");
      }
      if ((input.kind === "effect") !== Boolean(input.effect)) {
        throw new Error("Only an Acting Authority effect event carries effect details.");
      }
      if ((input.kind === "decision") !== Boolean(input.decision)) {
        throw new Error("An Acting Authority decision requires bounded decision authority details.");
      }
      let effect: ActingAuthorityEvent["effect"];
      let decision: ActingAuthorityEvent["decision"];
      if (input.decision) {
        const standingOrder = applicableStandingOrder(
          state,
          actingAuthority,
          input.commitmentId,
          input.decision.decisionClass,
          input.decision.target,
          { reversible: true, externallyBinding: false, incrementalSpendUsd: 0 },
        );
        if (!standingOrder) {
          throw new Error("The Acting Authority decision has no applicable active Standing Order.");
        }
        decision = { ...input.decision, standingOrderId: standingOrder.id };
      }
      if (input.effect) {
        if (input.effect.incrementalSpendUsd < 0 || !Number.isFinite(input.effect.incrementalSpendUsd)) {
          throw new Error("Acting Authority effect cost must be finite and nonnegative.");
        }
        const effectIntent = state.readEffectIntent(input.effect.effectIntentId);
        const applied = effectIntent?.status === "succeeded" ||
          (effectIntent?.status === "reconciled" &&
            effectIntent.reconciliation?.disposition !== "confirmed-not-applied");
        if (!effectIntent || effectIntent.commitmentId !== input.commitmentId || !applied) {
          throw new Error("An attributed Acting Authority effect requires a matching stabilized effect intent.");
        }
        const dispatchAuthorization = effectIntent.authorization.actingAuthority;
        const durableGrant = (actingAuthority.effectAuthorizations ?? []).find(
          (authorization) => authorization.id === dispatchAuthorization?.authorizationId,
        );
        if (
          !durableGrant ||
          durableGrant.effectClass !== input.effect.effectClass ||
          durableGrant.target !== input.effect.target ||
          durableGrant.reversible !== input.effect.reversible ||
          durableGrant.externallyBinding !== input.effect.externallyBinding ||
          durableGrant.incrementalSpendUsd !== input.effect.incrementalSpendUsd
        ) {
          throw new Error("The reported Acting Authority effect differs from its dispatch authorization.");
        }
        effect = { ...input.effect, standingOrderId: durableGrant.standingOrderId };
      }
      const event: ActingAuthorityEvent = {
        id: randomUUID(),
        kind: input.kind,
        commitmentId: input.commitmentId,
        summary: input.summary,
        evidence: input.evidence,
        recordedAt: new Date().toISOString(),
        ...(effect ? { effect } : {}),
        ...(decision ? { decision } : {}),
      };
      state.appendActingAuthoritySnapshots([{
        ...actingAuthority,
        events: [...actingAuthority.events, event],
      }]);
      return event;
    },

    prepareActingAuthorityHandoff(actingAuthorityId, ownerTurnId) {
      requireCurrentOwnerTurn(state, ownerTurnId);
      const actingAuthority = state.readActingAuthority(actingAuthorityId);
      if (!actingAuthority) throw new Error(`Unknown Acting Authority ${actingAuthorityId}.`);
      if (actingAuthority.state === "ended") {
        throw new Error(`Acting Authority ${actingAuthorityId} already returned command.`);
      }
      assertActingAuthorityEffectsSafeForHandoff(state, actingAuthority);
      if (actingAuthority.handoff) {
        if (actingAuthority.handoff.preparedForOwnerTurnId === ownerTurnId) {
          return actingAuthority.handoff;
        }
        const { deliveredAt: _deliveredAt, ...undeliveredHandoff } = actingAuthority.handoff;
        const refreshedHandoff: ActingAuthorityHandoff = {
          ...undeliveredHandoff,
          preparedForOwnerTurnId: ownerTurnId,
          preparedAt: new Date().toISOString(),
        };
        state.appendActingAuthoritySnapshots([{
          ...actingAuthority,
          handoff: refreshedHandoff,
        }]);
        return refreshedHandoff;
      }
      const summaries = (kind: ActingAuthorityEvent["kind"]): string[] =>
        actingAuthority.events.filter((event) => event.kind === kind).map((event) => event.summary);
      const handoff: ActingAuthorityHandoff = {
        preparedForOwnerTurnId: ownerTurnId,
        preparedAt: new Date().toISOString(),
        decisions: summaries("decision"),
        effects: summaries("effect"),
        exceptions: summaries("exception"),
        risks: summaries("risk"),
        uncertainty: summaries("uncertainty"),
      };
      state.appendActingAuthoritySnapshots([{
        ...actingAuthority,
        state: "handoff-pending",
        handoff,
      }]);
      return handoff;
    },

    observeActingAuthorityHandoffDelivered(actingAuthorityId, ownerTurnId, leadAgentResponse) {
      requireOwnerTurn(state, ownerTurnId);
      if (
        state.latestOwnerTurnId() !== ownerTurnId ||
        state.leadAgentResponse(ownerTurnId) !== leadAgentResponse
      ) {
        throw new Error("Acting Authority delivery requires the persisted response to the current Owner turn.");
      }
      const actingAuthority = state.readActingAuthority(actingAuthorityId);
      if (!actingAuthority?.handoff || actingAuthority.state !== "handoff-pending") {
        throw new Error("Acting Authority has no pending handoff to deliver.");
      }
      if (actingAuthority.handoff.preparedForOwnerTurnId !== ownerTurnId) {
        throw new Error("Acting Authority handoff belongs to a different prepared Owner turn.");
      }
      assertHandoffPresented(actingAuthority.handoff, leadAgentResponse);
      state.appendActingAuthoritySnapshots([{
        ...actingAuthority,
        state: "ended",
        handoff: { ...actingAuthority.handoff, deliveredAt: new Date().toISOString() },
      }]);
    },

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
        ...(draft.review
          ? {
              review: {
                required: true as const,
                reasons: [...new Set(draft.review.reasons)],
                status: "pending" as const,
                findings: [],
              },
            }
          : {}),
      };
      const ready = { ...committed, state: "ready" as const };
      const active = { ...ready, state: "active" as const };
      state.appendCommitmentSnapshots([committed, ready, active]);
      return active;
    },

    recordCommitmentOwnerAttention(commitmentId, input) {
      if (!input.kind || !input.reason.trim() || !input.nextAction.trim()) {
        throw new Error("Material Commitment attention requires a kind, reason, and recovery condition.");
      }
      const commitment = state.readCommitment(commitmentId);
      if (!commitment) throw new Error(`Unknown Commitment ${commitmentId}.`);
      if (["accepted", "cancelled", "superseded"].includes(commitment.state)) {
        throw new Error(`Terminal Commitment ${commitmentId} cannot require Owner attention.`);
      }
      if (input.cause) {
        if (input.kind !== "recovery-exhausted") {
          throw new Error("Only exhausted recovery attention can reference a Worker recovery cause.");
        }
        const worker = requireWorkerSession(state, input.cause.workerSessionId);
        if (
          worker.ownerAttention?.kind !== "recovery-exhausted" ||
          worker.assignment.commitmentId !== commitmentId
        ) {
          throw new Error("Commitment attention must reference an exhausted Worker in the same scope.");
        }
      }
      const material: Commitment = {
        ...commitment,
        condition: {
          kind: "blocked",
          reason: input.reason,
          nextAction: input.nextAction,
          ownerAttention: input.kind,
          ...(input.cause ? { ownerAttentionCause: input.cause } : {}),
        },
      };
      state.appendCommitmentSnapshots([material]);
      return material;
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
      const { condition: _condition, review, ...unblocked } = commitment;
      let resumedReview = review;
      if (review?.status === "changes-requested") {
        const { reviewerWorkerSessionId: _reviewerWorkerSessionId, ...reviewWithoutReviewer } = review;
        resumedReview = reviewWithoutReviewer;
      }
      state.appendCommitmentSnapshots([
        {
          ...unblocked,
          ...(resumedReview ? { review: resumedReview } : {}),
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
      const hasRecoveryTarget = Boolean(input.recoveryOfWorkerSessionId);
      const hasRecoveryReason = Boolean(input.recoveryReason?.trim());
      if (hasRecoveryTarget !== hasRecoveryReason) {
        throw new Error("A recovery Worker requires both its exhausted Worker and changed hypothesis.");
      }
      let recoveryCoordination: Extract<
        NonNullable<WorkerAssignmentBase["coordination"]>,
        { role: "recovery" }
      > | undefined;
      if (input.recoveryOfWorkerSessionId && input.recoveryReason) {
        const exhausted = requireWorkerSession(state, input.recoveryOfWorkerSessionId);
        if (exhausted.ownerAttention?.kind !== "recovery-exhausted") {
          throw new Error(`Worker Session ${exhausted.id} has no exhausted recovery to assign.`);
        }
        if (
          exhausted.assignment.targetProjectPath !== input.targetProjectPath ||
          exhausted.assignment.commitmentId !== input.commitmentId
        ) {
          throw new Error("Recovery Ownership must preserve Target Project and Commitment scope.");
        }
        recoveryCoordination = {
          role: "recovery",
          recoveryOfWorkerSessionId: exhausted.id,
          reason: input.recoveryReason,
        };
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
          ...(recoveryCoordination ? { coordination: recoveryCoordination } : {}),
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
      const actingAuthorityAuthorization = effectDispatchAuthorization(
        state,
        input.commitmentId,
        input.actingAuthorityEffectAuthorizationId,
      );
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
          coordination: {
            role: "implementer",
            ...(commitment.review?.status === "changes-requested"
              ? {
                  repairOfReviewFindingIds: commitment.review.findings
                    .filter((finding) => finding.disposition === "must-fix")
                    .map((finding) => finding.id),
                }
              : {}),
          },
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
          ...(actingAuthorityAuthorization ? { actingAuthority: actingAuthorityAuthorization } : {}),
        },
        retryRule: "Reconcile the prior effect before starting any replacement assignment.",
        status: "pending",
      };
      state.startWorkerExecution([workerSession], executionAttempt, effectIntent);
      return { workerSession, executionAttempt };
    },

    delegateReviewWorker(input) {
      const implementationWorker = requireWorkerSession(state, input.implementationWorkerSessionId);
      if (
        implementationWorker.assignment.readOnly ||
        implementationWorker.assignment.coordination?.role !== "implementer" ||
        implementationWorker.state !== "completed" ||
        !implementationWorker.outcome ||
        !implementationWorker.assignment.commitmentId
      ) {
        throw new Error("Independent Review requires one completed implementing Worker assignment.");
      }
      const commitment = state.readCommitment(implementationWorker.assignment.commitmentId);
      if (!commitment?.review?.required || commitment.review.status !== "pending") {
        throw new Error("The implementing Worker Commitment has no pending independent Review.");
      }
      if (
        commitment.review.implementationWorkerSessionId &&
        commitment.review.implementationWorkerSessionId !== implementationWorker.id
      ) {
        throw new Error("Independent Review requires the implementation with refreshed Verification.");
      }
      if (!input.prompt.trim() || !input.modelSelection.model.trim() || !input.modelPolicyRevision.trim()) {
        throw new Error("A reviewing Worker requires a prompt and Model Policy.");
      }
      const workerSessionId = randomUUID();
      const executionAttemptId = randomUUID();
      const reviewContract =
        "Review independently. Findings must cite exactly one basis: criterion, evidence, or risk. " +
        "Do not modify files. In CMD_RIKER_OUTCOME include reviewFindings as an array of " +
        "{basis, disposition, summary, evidence}; disposition is must-fix or follow-up.\n\n" +
        `Implementation outcome: ${JSON.stringify(implementationWorker.outcome)}`;
      const workerSession: WorkerSession = {
        id: workerSessionId,
        assignment: {
          objective: `Independently review Worker Session ${implementationWorker.id}.`,
          prompt: `${input.prompt}\n\n${reviewContract}`,
          targetProjectPath: implementationWorker.assignment.targetProjectPath,
          readOnly: true,
          modelPolicyRevision: input.modelPolicyRevision,
          commitmentId: implementationWorker.assignment.commitmentId,
          coordination: {
            role: "reviewer",
            reviewOfWorkerSessionId: implementationWorker.id,
          },
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
      state.appendCommitmentSnapshots([{
        ...commitment,
        review: {
          ...commitment.review,
          reviewerWorkerSessionId: workerSessionId,
          implementationWorkerSessionId: implementationWorker.id,
        },
      }]);
      recordCoordinationMessage(state, {
        fromWorkerSessionId: implementationWorker.id,
        toWorkerSessionId: workerSessionId,
        commitmentId: commitment.id,
        kind: "review-request",
        summary: "Review the completed implementation against its criteria, evidence, and concrete risks.",
        evidence: implementationWorker.outcome.verificationResults,
      });
      return { workerSession, executionAttempt };
    },

    adjudicateReview(commitmentId, decisions) {
      const commitment = state.readCommitment(commitmentId);
      if (!commitment?.review || commitment.review.status !== "awaiting-adjudication") {
        throw new Error("Only Review findings awaiting Lead adjudication can be decided.");
      }
      const pendingFindings = commitment.review.findings.filter(
        (finding) => !finding.leadDisposition,
      );
      const decisionIds = new Set(decisions.map((decision) => decision.reviewFindingId));
      if (
        decisions.length !== pendingFindings.length ||
        decisionIds.size !== decisions.length ||
        pendingFindings.some((finding) => !decisionIds.has(finding.id)) ||
        decisions.some((decision) => !decision.rationale.trim())
      ) {
        throw new Error("Lead adjudication must decide every new Review finding with rationale.");
      }
      const decidedAt = new Date().toISOString();
      const findings = commitment.review.findings.map((finding) => {
        const decision = decisions.find((candidate) => candidate.reviewFindingId === finding.id);
        return decision
          ? {
              ...finding,
              leadDisposition: {
                authority: "lead-agent" as const,
                kind: decision.disposition,
                rationale: decision.rationale,
                decidedAt,
              },
            }
          : finding;
      });
      const mustFix = decisions.some((decision) => decision.disposition === "must-fix");
      const { condition: _condition, ...unblocked } = commitment;
      const adjudicated: Commitment = mustFix
        ? {
            ...unblocked,
            state: "active",
            condition: {
              kind: "blocked",
              reason: "Lead adjudication requires repair of one or more must-fix Review findings.",
              nextAction: "Repair the adjudicated findings, refresh Verification, and target re-review.",
            },
            review: { ...commitment.review, status: "changes-requested", findings },
          }
        : commitment.verification?.passed
          ? {
              ...unblocked,
              state: "accepted",
              review: { ...commitment.review, status: "passed", findings },
              acceptance: {
                authority: "lead-agent",
                basis: "objective-criteria",
                acceptedAt: decidedAt,
              },
            }
          : {
              ...unblocked,
              state: "active",
              review: { ...commitment.review, status: "passed", findings },
            };
      state.appendCommitmentSnapshots([adjudicated]);
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

    reserveWorkerQuestionForOwner(questionId, reason) {
      if (!reason.trim()) throw new Error("An Owner-reserved Worker question requires a reason.");
      const question = state.readWorkerQuestion(questionId);
      if (!question) throw new Error(`Unknown Worker question ${questionId}.`);
      if (question.status !== "open" && question.status !== "answer-recorded") {
        throw new Error(`Worker question ${questionId} no longer needs Owner attention.`);
      }
      const reserved: WorkerQuestion = {
        ...question,
        ownerAttention: { kind: "owner-reserved-decision", reason },
      };
      state.appendWorkerQuestionSnapshots([reserved]);
      return reserved;
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
      const reviewAssignment = worker.assignment.coordination?.role === "reviewer"
        ? worker.assignment.coordination
        : undefined;
      const reviewFindings = reviewAssignment
        ? normalizeReviewFindings(input.reportedOutcome?.reviewFindings)
        : undefined;
      const invalidReviewReport = Boolean(
        reviewAssignment && input.status === "completed" && !reviewFindings,
      );
      const attemptStatus = cancelled
        ? "cancelled"
        : input.status !== "completed" || missingReport || contradictoryReadOnlyReport || invalidReviewReport
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
        ...(reviewFindings ? { reviewFindings } : {}),
        ...(input.reportedOutcome?.unresolvedUncertainty ||
        input.status === "failed" ||
        !input.processGone ||
        missingReport ||
        contradictoryReadOnlyReport
        || invalidReviewReport
          ? {
              unresolvedUncertainty:
                (contradictoryReadOnlyReport
                  ? "A read-only Worker reported affected artifacts."
                  : undefined) ??
                (missingReport ? "The Worker omitted its required structured outcome." : undefined) ??
                (invalidReviewReport
                  ? "The reviewing Worker omitted valid criterion-, evidence-, or risk-based findings."
                  : undefined) ??
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
      if (attemptStatus === "completed" && reviewAssignment && reviewFindings) {
        settleIndependentReview(
          state,
          worker,
          reviewAssignment.reviewOfWorkerSessionId,
          reviewFindings,
        );
      }
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
  const passed = result.status === "succeeded" && result.uncertainty === null;
  let review = commitment.review;
  if (passed && review?.status === "changes-requested") {
    const repairWorker = result.causedByWorker
      ? state.readWorkerSession(result.causedByWorker.workerSessionId)
      : undefined;
    const repairedFindingIds = repairWorker?.assignment.coordination?.role === "implementer"
      ? repairWorker.assignment.coordination.repairOfReviewFindingIds ?? []
      : [];
    const mustFixFindingIds = review.findings
      .filter((finding) => finding.disposition === "must-fix")
      .map((finding) => finding.id);
    if (
      !repairWorker ||
      repairWorker.id !== result.causedByWorker?.workerSessionId ||
      mustFixFindingIds.some((findingId) => !repairedFindingIds.includes(findingId))
    ) {
      throw new Error("Must-fix Review requires an attributed repair attempt and refreshed Verification.");
    }
    const { reviewerWorkerSessionId: _reviewerWorkerSessionId, ...reviewWithoutReviewer } = review;
    review = {
      ...reviewWithoutReviewer,
      status: "pending",
      implementationWorkerSessionId: repairWorker.id,
    };
  }
  const verifying: Commitment = {
    ...commitment,
    state: "verifying",
    ...(review ? { review } : {}),
  };
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
    ? review?.required && review.status !== "passed"
      ? {
          ...verifying,
          verification,
          review,
        }
      : {
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
  if (draft.review && !hasOperationCriterion) {
    throw new Error("Independent Review currently requires a Target Project operation Commitment.");
  }
  if (draft.review && draft.review.reasons.length === 0) {
    throw new Error("A required independent Review must name a concrete reason.");
  }
}

function normalizeReviewFindings(
  findings: WorkerReportedOutcome["reviewFindings"],
): ReviewFinding[] | undefined {
  if (!Array.isArray(findings)) return undefined;
  if (findings.some((finding) =>
    !["criterion", "evidence", "risk"].includes(finding.basis) ||
    !["must-fix", "follow-up"].includes(finding.disposition) ||
    !finding.summary.trim() ||
    !finding.evidence.trim()
  )) {
    return undefined;
  }
  return findings.map((finding) => ({
    id: randomUUID(),
    basis: finding.basis,
    disposition: finding.disposition,
    summary: finding.summary,
    evidence: finding.evidence,
  }));
}

function settleIndependentReview(
  state: OrchestrationState,
  reviewingWorker: WorkerSession,
  implementationWorkerSessionId: string,
  findings: ReviewFinding[],
): void {
  const implementationWorker = requireWorkerSession(state, implementationWorkerSessionId);
  const commitmentId = reviewingWorker.assignment.commitmentId;
  if (
    !commitmentId ||
    implementationWorker.assignment.commitmentId !== commitmentId ||
    implementationWorker.assignment.readOnly ||
    implementationWorker.assignment.coordination?.role !== "implementer"
  ) {
    throw new Error("Review outcome is not tied to the implementing Worker assignment.");
  }
  const commitment = state.readCommitment(commitmentId);
  if (
    !commitment?.review?.required ||
    commitment.review.status !== "pending" ||
    commitment.review.reviewerWorkerSessionId !== reviewingWorker.id
  ) {
    throw new Error("Review outcome is not attributed to the pending independent Review.");
  }
  const reviewFindings = [...commitment.review.findings, ...findings];
  const reviewed: Commitment = findings.length > 0
    ? {
        ...commitment,
        state: "active",
        condition: {
          kind: "blocked",
          reason: "Independent Review findings require Lead adjudication.",
          nextAction: "Decide must-fix work, documented exceptions, and follow-ups with rationale.",
        },
        review: { ...commitment.review, status: "awaiting-adjudication", findings: reviewFindings },
      }
    : commitment.verification?.passed
      ? {
          ...commitment,
          state: "accepted",
          review: { ...commitment.review, status: "passed", findings: reviewFindings },
          acceptance: {
            authority: "lead-agent",
            basis: "objective-criteria",
            acceptedAt: new Date().toISOString(),
          },
        }
      : {
          ...commitment,
          state: "active",
          review: { ...commitment.review, status: "passed", findings: reviewFindings },
        };
  state.appendCommitmentSnapshots([reviewed]);
  for (const finding of findings) {
    recordCoordinationMessage(state, {
      fromWorkerSessionId: reviewingWorker.id,
      toWorkerSessionId: implementationWorker.id,
      commitmentId,
      kind: "review-finding",
      summary: finding.summary,
      evidence: [finding.evidence],
      reviewFindingId: finding.id,
    });
  }
}

function recordCoordinationMessage(
  state: OrchestrationState,
  input: Omit<CoordinationMessage, "id" | "recordedAt">,
): CoordinationMessage {
  const sender = requireWorkerSession(state, input.fromWorkerSessionId);
  const recipient = requireWorkerSession(state, input.toWorkerSessionId);
  if (sender.id === recipient.id) throw new Error("A Coordination Message requires two Worker Sessions.");
  if (
    !input.summary.trim() ||
    input.evidence.length === 0 ||
    input.evidence.some((item) => !item.trim())
  ) {
    throw new Error("A Coordination Message requires a summary and evidence.");
  }
  if (
    sender.assignment.commitmentId !== input.commitmentId ||
    recipient.assignment.commitmentId !== input.commitmentId
  ) {
    throw new Error("A Coordination Message cannot create work or expand assignment scope.");
  }
  if (
    ["completed", "blocked", "failed", "cancelled"].includes(recipient.state) &&
    input.kind !== "review-finding"
  ) {
    throw new Error("A terminal Worker Session cannot accept a new actionable Coordination Message.");
  }
  const reviewRelation =
    recipient.assignment.coordination?.role === "reviewer" &&
    recipient.assignment.coordination.reviewOfWorkerSessionId === sender.id;
  const findingRelation =
    sender.assignment.coordination?.role === "reviewer" &&
    sender.assignment.coordination.reviewOfWorkerSessionId === recipient.id;
  if (input.kind === "review-request" && !reviewRelation) {
    throw new Error("A review request requires an existing matching reviewing assignment.");
  }
  if (input.kind === "review-finding" && (!findingRelation || !input.reviewFindingId)) {
    throw new Error("A review finding requires the attributed reviewing assignment and finding.");
  }
  if (
    !["review-request", "review-finding"].includes(input.kind) &&
    !reviewRelation &&
    !findingRelation
  ) {
    throw new Error("A Coordination Message requires an existing direct assignment relationship.");
  }
  const message: CoordinationMessage = {
    id: randomUUID(),
    ...input,
    recordedAt: new Date().toISOString(),
  };
  state.appendCoordinationMessage(message);
  return message;
}

function requireOwnerTurn(state: OrchestrationState, ownerTurnId: string): void {
  if (state.ownerTurnSequence(ownerTurnId) === undefined) {
    throw new Error(`Unknown Owner turn ${ownerTurnId}.`);
  }
}

function requireCurrentOwnerTurn(state: OrchestrationState, ownerTurnId: string): void {
  requireOwnerTurn(state, ownerTurnId);
  if (state.latestOwnerTurnId() !== ownerTurnId || state.leadAgentResponse(ownerTurnId) !== undefined) {
    throw new Error("Authority changes require the current unanswered Owner turn.");
  }
}

function requireExplicitCurrentOwnerInstruction(
  state: OrchestrationState,
  ownerTurnId: string,
  ownerInstructionQuote: string,
): string {
  requireCurrentOwnerTurn(state, ownerTurnId);
  const quote = ownerInstructionQuote.trim();
  const ownerMessage = state.ownerMessage(ownerTurnId);
  if (quote.length < 8 || ownerMessage?.trim() !== quote) {
    throw new Error("Authority requires the complete verbatim current Owner instruction.");
  }
  return quote;
}

function validateStandingOrderOwnerInstruction(
  draft: StandingOrderDraft,
  ownerInstruction: string,
): void {
  if (draft.instruction.trim() !== ownerInstruction) {
    throw new Error("A Standing Order instruction cannot broaden the verbatim Owner instruction.");
  }
  const normalized = ownerInstruction.toLowerCase().replaceAll("-", " ");
  const namedBounds = [...draft.effectClasses, ...draft.targets].every((bound) =>
    normalized.includes(bound.toLowerCase().replaceAll("-", " "))
  );
  if (!namedBounds) {
    throw new Error("The Owner instruction must name every Standing Order effect class and target.");
  }
  const escapedSpend = String(draft.maximumIncrementalSpendUsd).replace(".", "\\.");
  const explicitSpend = new RegExp(
    `(?:cost\\s+${escapedSpend}\\b|\\b${escapedSpend}\\s+usd\\b|\\$${escapedSpend}\\b)`,
    "i",
  ).test(ownerInstruction);
  if (!explicitSpend) {
    throw new Error("The Owner instruction must state the Standing Order cost bound explicitly.");
  }
  if (!ownerInstruction.includes(draft.validUntil)) {
    throw new Error("The Owner instruction must state the Standing Order expiration explicitly.");
  }
  const negatedEffectClass = draft.effectClasses.some((effectClass) => {
    const words = effectClass.toLowerCase().replaceAll("-", " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b(do not|don't|never|not)\\s+(?:\\w+\\s+){0,3}${words}\\b`, "i")
      .test(normalized);
  });
  if (negatedEffectClass) {
    throw new Error("A negated effect class cannot create Standing Order authority.");
  }
  if (draft.allowIrreversibleEffects && !normalized.includes("irreversible")) {
    throw new Error("Irreversible authority must be explicit in the Owner instruction.");
  }
  if (draft.allowExternallyBindingEffects && !normalized.includes("externally binding")) {
    throw new Error("Externally binding authority must be explicit in the Owner instruction.");
  }
  if (
    draft.allowIrreversibleEffects &&
    /\b(no|not|never|without)\b.{0,30}\birreversible\b/i.test(normalized)
  ) {
    throw new Error("Negated irreversible effects cannot create Standing Order authority.");
  }
  if (
    draft.allowExternallyBindingEffects &&
    /\b(no|not|never|without)\b.{0,30}\bexternally binding\b/i.test(normalized)
  ) {
    throw new Error("Negated externally binding effects cannot create Standing Order authority.");
  }
}

function validateStandingOrderDraft(state: OrchestrationState, draft: StandingOrderDraft): void {
  if (!draft.title.trim() || !draft.instruction.trim()) {
    throw new Error("A Standing Order requires a title and instruction.");
  }
  if (
    draft.commitmentIds.length === 0 ||
    draft.effectClasses.length === 0 ||
    draft.targets.length === 0
  ) {
    throw new Error("A Standing Order requires bounded Commitments, effect classes, and targets.");
  }
  if (
    draft.commitmentIds.some((id) => !state.readCommitment(id)) ||
    draft.targets.some((target) => !target.trim())
  ) {
    throw new Error("A Standing Order must reference existing Commitments and named targets.");
  }
  if (
    !Number.isFinite(draft.maximumIncrementalSpendUsd) ||
    draft.maximumIncrementalSpendUsd < 0
  ) {
    throw new Error("A Standing Order cost bound must be finite and nonnegative.");
  }
  if (!Number.isFinite(Date.parse(draft.validUntil)) || Date.parse(draft.validUntil) <= Date.now()) {
    throw new Error("A Standing Order requires a future expiration.");
  }
}

function requireActiveActingAuthority(
  state: OrchestrationState,
  actingAuthorityId: string,
): ActingAuthority {
  const actingAuthority = state.readActingAuthority(actingAuthorityId);
  if (!actingAuthority) throw new Error(`Unknown Acting Authority ${actingAuthorityId}.`);
  if (actingAuthority.state !== "active") {
    throw new Error(`Acting Authority ${actingAuthorityId} is not active.`);
  }
  return actingAuthority;
}

function applicableStandingOrder(
  state: OrchestrationState,
  actingAuthority: ActingAuthority,
  commitmentId: string,
  effectClass: StandingOrderEffectClass,
  target: string,
  bounds: {
    reversible: boolean;
    externallyBinding: boolean;
    incrementalSpendUsd: number;
  },
): StandingOrder | undefined {
  const now = Date.now();
  return actingAuthority.standingOrderIds
    .map((id) => state.readStandingOrder(id))
    .find((order) =>
      order?.state === "active" &&
      Date.parse(order.validUntil) > now &&
      order.commitmentIds.includes(commitmentId) &&
      order.effectClasses.includes(effectClass) &&
      order.targets.includes(target) &&
      bounds.incrementalSpendUsd <= order.maximumIncrementalSpendUsd &&
      (!bounds.externallyBinding || order.allowExternallyBindingEffects) &&
      (bounds.reversible || order.allowIrreversibleEffects)
    );
}

function effectDispatchAuthorization(
  state: OrchestrationState,
  commitmentId: string,
  authorizationId: string | undefined,
): NonNullable<EffectIntent["authorization"]["actingAuthority"]> | undefined {
  const actingAuthority = state.readActingAuthorities().at(-1);
  if (!actingAuthority || actingAuthority.state === "ended") {
    if (authorizationId) {
      throw new Error("An Acting Authority effect authorization cannot outlive command authority.");
    }
    return undefined;
  }
  if (!actingAuthority.commitmentIds.includes(commitmentId)) {
    if (authorizationId) {
      throw new Error("Acting Authority cannot authorize an unrelated Commitment effect.");
    }
    return undefined;
  }
  if (actingAuthority.state !== "active" || !authorizationId) {
    throw new Error("Effect dispatch is blocked without active Acting Authority authorization.");
  }
  const authorization = (actingAuthority.effectAuthorizations ?? []).find(
    (candidate) => candidate.id === authorizationId,
  );
  if (!authorization || authorization.commitmentId !== commitmentId) {
    throw new Error("Effect dispatch does not match its durable Acting Authority authorization.");
  }
  return {
    actingAuthorityId: actingAuthority.id,
    authorizationId: authorization.id,
    standingOrderId: authorization.standingOrderId,
  };
}

function assertActingAuthorityEffectsSafeForHandoff(
  state: OrchestrationState,
  actingAuthority: ActingAuthority,
): void {
  const relevant = state.readEffectIntents().filter((effectIntent) =>
    actingAuthority.commitmentIds.includes(effectIntent.commitmentId) &&
    Date.parse(effectIntent.authorization.validatedAt) >= Date.parse(actingAuthority.startedAt)
  );
  const unsettled = relevant.filter((effectIntent) =>
    ["pending", "dispatching", "unknown"].includes(effectIntent.status)
  );
  if (unsettled.length > 0) {
    throw new Error("Acting Authority cannot return command with unsettled effect intents.");
  }
  const representedEffectIntentIds = new Set(
    actingAuthority.events.flatMap((event) => event.effect?.effectIntentId ? [event.effect.effectIntentId] : []),
  );
  const unreportedApplied = relevant.filter((effectIntent) => {
    const applied = effectIntent.status === "succeeded" ||
      (effectIntent.status === "reconciled" &&
        effectIntent.reconciliation?.disposition !== "confirmed-not-applied");
    return applied && !representedEffectIntentIds.has(effectIntent.id);
  });
  if (unreportedApplied.length > 0) {
    throw new Error("Acting Authority cannot return command before applied effects are represented in the handoff.");
  }
}

function assertHandoffPresented(
  handoff: ActingAuthorityHandoff,
  leadAgentResponse: string,
): void {
  const categories = ["decisions", "effects", "exceptions", "risks", "uncertainty"] as const;
  const normalizedResponse = leadAgentResponse.toLowerCase();
  const allCategoriesPresented = categories.every((category) => normalizedResponse.includes(category));
  const allSummariesPresented = categories.every((category) =>
    handoff[category].every((summary) => leadAgentResponse.includes(summary))
  );
  if (!allCategoriesPresented || !allSummariesPresented) {
    throw new Error("Acting Authority ends only after the Lead response presents the complete handoff.");
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
    workerSession: {
      ...worker,
      state: "blocked",
      outcome,
      ownerAttention: {
        kind: "recovery-exhausted",
        reason: "Automatic Worker recovery exhausted its bounded attempts.",
        nextAction: "The Owner must choose whether to diagnose, redelegate, or abandon the Assignment.",
      },
    },
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
