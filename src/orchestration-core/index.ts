import { randomUUID } from "node:crypto";

import type { ModelSelection } from "../model-selection.ts";
import type {
  EffectIntent,
  TargetProjectOperationAttempt,
  TargetProjectOperationResult,
} from "../target-project-operations/index.ts";

export type OwnerConfiguration = {
  targetProject: { path: string };
  modelSelection: ModelSelection;
  modelFallbacks?: ModelSelection[];
  modelRequirements?: LeadModelRequirements;
  modelPolicyRevision: string;
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
  settleTargetProjectOperation(
    attempt: TargetProjectOperationAttempt,
    effectIntent: EffectIntent,
  ): void;
  readTargetProjectOperationAttempt(attemptId: string): TargetProjectOperationAttempt | undefined;
  readTargetProjectOperationAttempts(): TargetProjectOperationAttempt[];
  readEffectIntent(effectIntentId: string): EffectIntent | undefined;
  readEffectIntents(): EffectIntent[];
  readLeadTurnAttempts(): LeadTurnAttempt[];
}

export interface OrchestrationCore {
  activateLeadModelPolicy(
    policy: LeadModelPolicy,
    validations: readonly ModelCandidateValidation[],
  ): void;
  recordCommitment(ownerTurnId: string, draft: CommitmentDraft): Commitment;
  reconcileInterruptedCommitments(): void;
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
}

export function createOrchestrationCore(state: OrchestrationState): OrchestrationCore {
  return {
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
        };
        state.settleTargetProjectOperation(
          { ...attempt, status: "unknown", result },
          { ...effectIntent, status: "unknown" },
        );
        recordTargetProjectOperationVerification(state, attempt.commitmentId, result, "reconciling");
      }
      for (const commitment of state.readCommitments()) {
        if (commitment.state !== "active" || commitment.condition) continue;
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
  state.appendCommitmentSnapshots([verifying, settled]);
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
