import type { AuthoritativeState } from "../authoritative-state/index.ts";
import {
  PiTurnFailure,
  type PiTurnAdapter,
} from "../conversation-runtime/index.ts";
import {
  createForgeOperations,
  type ForgeOperations,
} from "../forge-operations/index.ts";
import {
  createOrchestrationCore,
  defaultLeadModelRequirements,
  type ActingAuthorityEffectRequest,
} from "../orchestration-core/index.ts";
import {
  createTargetProjectOperations,
  type TargetProjectOperations,
} from "../target-project-operations/index.ts";
import type { WorkerSupervisor } from "../worker-supervisor/index.ts";

export type LeadAgentRuntime = {
  completeOwnerTurn(
    ownerInput: string,
    onOwnerTurnRecorded?: (turnId: string) => void,
  ): Promise<string>;
};

export class LeadAgentRuntimeDiagnostic extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function createLeadAgentRuntime(input: {
  state: AuthoritativeState;
  adapter: PiTurnAdapter;
  workerSupervisor?: WorkerSupervisor;
  targetProjectOperations?: TargetProjectOperations;
  forgeOperations?: ForgeOperations;
}): LeadAgentRuntime {
  const targetProjectOperations = input.targetProjectOperations ??
    createTargetProjectOperations(input.state);
  const forgeOperations = input.forgeOperations ?? createForgeOperations(input.state);
  return {
    completeOwnerTurn: (ownerInput, onOwnerTurnRecorded) =>
      completeOwnerTurn({
        ...input,
        targetProjectOperations,
        forgeOperations,
        ownerInput,
        ...(onOwnerTurnRecorded ? { onOwnerTurnRecorded } : {}),
      }),
  };
}

export function commitmentNotice(commitment: {
  id: string;
  outcome: string;
  state: string;
  condition?: { kind: string };
}): string {
  const status = commitment.state === "awaiting-acceptance"
    ? "awaiting Owner Acceptance"
    : commitment.condition?.kind ?? commitment.state;
  return `Commitment ${commitment.id} ${status}: ${commitment.outcome}`;
}

async function completeOwnerTurn(input: {
  state: AuthoritativeState;
  adapter: PiTurnAdapter;
  ownerInput: string;
  workerSupervisor?: WorkerSupervisor;
  targetProjectOperations: TargetProjectOperations;
  forgeOperations: ForgeOperations;
  onOwnerTurnRecorded?: (turnId: string) => void;
}): Promise<string> {
  const conversation = input.state.readOwnerConversation();
  if (!conversation) throw new Error("Authoritative state is not configured.");
  const orchestration = createOrchestrationCore(input.state);
  const turnId = input.state.appendOwnerMessage(input.ownerInput);
  input.onOwnerTurnRecorded?.(turnId);
  const commitmentsBefore = new Map(
    input.state
      .readCommitments()
      .map((commitment) => [commitment.id, commitmentFingerprint(commitment)]),
  );
  const candidates = [conversation.modelSelection, ...(conversation.modelFallbacks ?? [])];
  for (const [index, modelSelection] of candidates.entries()) {
    const validation = await input.adapter.validateSelection(
      modelSelection,
      conversation.modelRequirements ?? defaultLeadModelRequirements,
    );
    if (orchestration.modelCandidateDecision(validation) === "skip") continue;
    const attempt = orchestration.startLeadTurnAttempt({
      ownerTurnId: turnId,
      modelSelection,
      modelPolicyRevision: conversation.modelPolicyRevision,
      ...(index > 0 ? { selectionReason: "fallback-after-ineligible-candidate" as const } : {}),
    });
    try {
      const workerCapabilities = input.workerSupervisor?.capabilities();
      const response = await input.adapter.completeTurn({
        conversation: conversation.messages,
        ownerInput: input.ownerInput,
        modelSelection,
        commitments: input.state.readCommitments(),
        standingOrders: orchestration.standingOrdersView(),
        ...(orchestration.actingAuthorityView()
          ? { actingAuthority: orchestration.actingAuthorityView()! }
          : {}),
        authorityActions: {
          recordStandingOrder: (draft) => orchestration.recordStandingOrder(turnId, draft),
          revokeStandingOrder: (standingOrderId, reason) =>
            orchestration.revokeStandingOrder(standingOrderId, turnId, reason),
          beginActingAuthority: (authorityInput) =>
            orchestration.beginActingAuthority(turnId, authorityInput),
          recordActingAuthorityEvent: (actingAuthorityId, eventInput) =>
            orchestration.recordActingAuthorityEvent(actingAuthorityId, eventInput),
          prepareActingAuthorityHandoff: (actingAuthorityId) =>
            orchestration.prepareActingAuthorityHandoff(actingAuthorityId, turnId),
        },
        workers: orchestration.workerSessionsView(),
        workerQuestions: orchestration.workerQuestionsView(),
        ...(input.workerSupervisor
          ? {
              workerActions: {
                capabilities: {
                  nativeHarness: workerCapabilities!.nativeHarness,
                  effectful: workerCapabilities!.effectful,
                  nativeQuestions: workerCapabilities!.nativeQuestions,
                  cancellation: workerCapabilities!.cancellation,
                },
                delegate: (assignment: {
                  objective: string;
                  prompt: string;
                  commitmentId?: string;
                  recoveryOfWorkerSessionId?: string;
                  recoveryReason?: string;
                }) =>
                  input.workerSupervisor!.delegate({
                    ...assignment,
                    targetProjectPath: conversation.targetProject.path,
                    model: conversation.workerModelPolicy!.selection.model,
                    modelPolicyRevision: conversation.workerModelPolicy!.revision,
                  }),
                delegateReview: (assignment: {
                  implementationWorkerSessionId: string;
                  prompt: string;
                }) =>
                  input.workerSupervisor!.delegateReview({
                    ...assignment,
                    model: conversation.workerModelPolicy!.selection.model,
                    modelPolicyRevision: conversation.workerModelPolicy!.revision,
                  }),
                adjudicateReview: (adjudication) =>
                  orchestration.adjudicateReview(adjudication.commitmentId, adjudication.decisions),
                reserveOwnerDecision: (questionId: string, reason: string) => {
                  orchestration.reserveWorkerQuestionForOwner(questionId, reason);
                },
                ...(workerCapabilities!.effectful
                  ? {
                      delegateEffectful: (assignment: {
                        objective: string;
                        prompt: string;
                        commitmentId: string;
                        targets: string[];
                        actingAuthorityEffect?: ActingAuthorityEffectRequest;
                        recoveryOfWorkerSessionId?: string;
                        recoveryReason?: string;
                      }) => {
                        const { actingAuthorityEffect, ...boundedAssignment } = assignment;
                        const authorization = actingAuthorityEffect
                          ? orchestration.authorizeActingAuthorityEffect(actingAuthorityEffect)
                          : undefined;
                        return input.workerSupervisor!.delegateEffectful({
                          ...boundedAssignment,
                          targetProjectPath: conversation.targetProject.path,
                          model: conversation.workerModelPolicy!.selection.model,
                          modelPolicyRevision: conversation.workerModelPolicy!.revision,
                          timeoutMs: 20 * 60_000,
                          verification: {
                            operation: "test" as const,
                            workingDirectory: conversation.targetProject.path,
                            timeoutMs: 120_000,
                          },
                          ...(authorization
                            ? { actingAuthorityEffectAuthorizationId: authorization.id }
                            : {}),
                        });
                      },
                      answer: (questionId: string, answers: Record<string, string[]>) =>
                        input.workerSupervisor!.answer(questionId, turnId, answers),
                    }
                  : {}),
                ...(workerCapabilities!.cancellation
                  ? {
                      cancel: (workerSessionId: string, reason: string) =>
                        input.workerSupervisor!.cancel(workerSessionId, turnId, reason),
                    }
                  : {}),
              },
            }
          : {}),
        commitmentActions: {
          record: (draft) => orchestration.recordCommitment(turnId, draft),
          recordOwnerAttention: (commitmentId, attentionInput) => {
            orchestration.recordCommitmentOwnerAttention(commitmentId, attentionInput);
          },
          accept: (commitmentId) => orchestration.acceptCommitment(commitmentId, turnId),
          resume: (commitmentId) => orchestration.resumeCommitment(commitmentId, turnId),
          control: (commitmentId, action, reason, replacementCommitmentId) => {
            if (action === "pause") orchestration.pauseCommitment(commitmentId, turnId, reason);
            else if (action === "cancel") orchestration.cancelCommitment(commitmentId, turnId, reason);
            else {
              if (!replacementCommitmentId) {
                throw new Error("Supersession requires a replacement Commitment.");
              }
              orchestration.supersedeCommitment(
                commitmentId,
                turnId,
                reason,
                replacementCommitmentId,
              );
            }
          },
          executeOperation: async (commitmentId, operation, actingAuthorityEffect) => {
            const authorization = actingAuthorityEffect
              ? orchestration.authorizeActingAuthorityEffect(actingAuthorityEffect)
              : undefined;
            const result = await input.targetProjectOperations.execute({
              commitmentId,
              operation: { kind: operation, inputs: {} },
              checkout: conversation.targetProject.path,
              workingDirectory: conversation.targetProject.path,
              timeoutMs: 120_000,
              ...(authorization
                ? {
                    actingAuthorityEffectAuthorization: {
                      actingAuthorityId: authorization.actingAuthorityId,
                      authorizationId: authorization.id,
                      standingOrderId: authorization.standingOrderId,
                    },
                  }
                : {}),
            });
            orchestration.observeTargetProjectOperationResult(commitmentId, result);
            return result;
          },
        },
        forgeActions: {
          ...(conversation.forgeAuthorities?.github
            ? {
                commentOnGitHubIssue: async (operationInput, actingAuthorityEffect) => {
                  const authority = conversation.forgeAuthorities!.github!;
                  const authorization = orchestration.authorizeActingAuthorityEffect(
                    actingAuthorityEffect,
                  );
                  const result = await input.forgeOperations.execute({
                    commitmentId: operationInput.commitmentId,
                    operation: {
                      kind: "github-issue-comment",
                      repository: authority.repository,
                      issueNumber: operationInput.issueNumber,
                      body: operationInput.body,
                      expectedAccount: authority.account,
                    },
                    timeoutMs: 30_000,
                    actingAuthorityEffectAuthorization: {
                      actingAuthorityId: authorization.actingAuthorityId,
                      authorizationId: authorization.id,
                      standingOrderId: authorization.standingOrderId,
                    },
                  });
                  orchestration.observeForgeOperationResult(operationInput.commitmentId, result);
                  return result;
                },
              }
            : {}),
          ...(conversation.forgeAuthorities?.azure
            ? {
                inspectAzureSubscription: async (commitmentId) => {
                  const authority = conversation.forgeAuthorities!.azure!;
                  const result = await input.forgeOperations.execute({
                    commitmentId,
                    operation: {
                      kind: "azure-subscription-inspection",
                      subscriptionId: authority.subscriptionId,
                      expectedAccount: authority.account,
                    },
                    timeoutMs: 30_000,
                  });
                  orchestration.observeForgeOperationResult(commitmentId, result);
                  return result;
                },
              }
            : {}),
        },
      });
      const pendingSelfRepairAccounts = input.state.readSelfRepairs().flatMap((repair) =>
        repair.attempts.flatMap((repairAttempt) =>
          repairAttempt.activation && !repairAttempt.activation.deliveredAt
            ? [{ repair, attempt: repairAttempt, account: repairAttempt.activation.account }]
            : []
        )
      );
      const pendingCommitmentAccounts = input.state.readCommitments().filter(
        (commitment) => commitment.outcomeAccount && !commitment.outcomeAccount.deliveredAt,
      );
      const accountContents = [
        ...pendingSelfRepairAccounts.map(({ account }) => account),
        ...pendingCommitmentAccounts.map((commitment) => commitment.outcomeAccount!.content),
      ];
      const durableResponse = accountContents.length
        ? `${response.content}\n\n${accountContents.join("\n")}`
        : response.content;
      const deliveredAt = new Date().toISOString();
      const deliveredRepairs = [...new Set(pendingSelfRepairAccounts.map(({ repair }) => repair.id))]
        .map((repairId) => {
          const repair = pendingSelfRepairAccounts.find(
            (candidate) => candidate.repair.id === repairId,
          )!.repair;
          return {
            ...repair,
            attempts: repair.attempts.map((repairAttempt) =>
              repairAttempt.activation && !repairAttempt.activation.deliveredAt
                ? {
                    ...repairAttempt,
                    activation: { ...repairAttempt.activation, deliveredAt },
                  }
                : repairAttempt
            ),
          };
        });
      const deliveredCommitments = pendingCommitmentAccounts.map((commitment) => ({
        ...commitment,
        outcomeAccount: { ...commitment.outcomeAccount!, deliveredAt },
      }));
      input.state.appendLeadAgentMessageWithAccounts(
        turnId,
        durableResponse,
        { selfRepairs: deliveredRepairs, commitments: deliveredCommitments },
        {
          modelSelection,
          modelPolicyRevision: conversation.modelPolicyRevision,
          ...(index > 0
            ? { selectionReason: "fallback-after-ineligible-candidate" as const }
            : {}),
        },
      );
      orchestration.observeLeadResponse(turnId, durableResponse);
      const notices = input.state
        .readCommitments()
        .filter(
          (commitment) =>
            commitmentsBefore.get(commitment.id) !== commitmentFingerprint(commitment),
        )
        .map(commitmentNotice);
      const content = notices.length
        ? `${durableResponse}\n\n${notices.join("\n")}`
        : durableResponse;
      orchestration.settleLeadTurnAttempt(attempt.id, "completed");
      const pendingHandoff = orchestration.actingAuthorityView();
      if (
        pendingHandoff?.state === "handoff-pending" &&
        pendingHandoff.handoff?.preparedForOwnerTurnId === turnId
      ) {
        orchestration.observeActingAuthorityHandoffDelivered(
          pendingHandoff.id,
          turnId,
          durableResponse,
        );
      }
      return content;
    } catch (error) {
      if (!(error instanceof PiTurnFailure)) throw error;
      orchestration.settleLeadTurnAttempt(attempt.id, "failed", error.kind);
      const decision = orchestration.modelFailureDecision(error);
      if (decision === "fallback") continue;
      if (decision === "revalidate") {
        const updatedValidation = await input.adapter.validateSelection(
          modelSelection,
          conversation.modelRequirements ?? defaultLeadModelRequirements,
        );
        if (orchestration.modelCandidateDecision(updatedValidation) === "skip") continue;
      }
      orchestration.observeLeadTurnFailure(turnId, `Lead Model turn failed: ${error.kind}.`);
      break;
    }
  }
  throw new LeadAgentRuntimeDiagnostic(
    "CMD_RIKER_MODEL_UNAVAILABLE",
    "The configured Model did not complete the turn.",
  );
}

function commitmentFingerprint(commitment: {
  state: string;
  condition?: { kind: string };
}): string {
  return `${commitment.state}:${commitment.condition?.kind ?? "none"}`;
}
