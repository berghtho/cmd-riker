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
  const status = commitment.state === "accepted" || commitment.state === "awaiting-acceptance"
    ? "delivered"
    : commitment.condition?.kind ?? commitment.state;
  return `Work item ${status}: ${commitment.outcome}`;
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
  // Work Items are durable internal tracking; the model never fills forms for
  // them. A missing Work Item is minted from the objective at hand.
  const workItemFor = (
    workItemId: string | undefined,
    outcome: string,
    criterion?:
      | { kind: "target-project-operation"; operation: "test"; description: string }
      | {
          kind: "forge-operation";
          operation: "github-issue-comment" | "azure-subscription-inspection";
          description: string;
        },
  ): string =>
    workItemId ??
    orchestration.recordCommitment(turnId, {
      outcome,
      criteria: [
        criterion ?? {
          kind: "target-project-operation",
          operation: "test",
          description: "The declared Target Project test operation verifies the outcome.",
        },
      ],
    }).id;
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
      const harnessSettings = conversation.workerHarnessSettings ?? {};
      const activeHarness = workerCapabilities?.nativeHarness;
      const activeSetting = activeHarness ? harnessSettings[activeHarness] : undefined;
      const workerModel = activeHarness
        ? activeSetting?.model ??
          (conversation.workerModelPolicy?.selection.nativeHarness === activeHarness
            ? conversation.workerModelPolicy.selection.model
            : undefined)
        : undefined;
      const workerDisabled = activeSetting?.enabled === false;
      const workerAvailable = Boolean(input.workerSupervisor && !workerDisabled && workerModel);
      const workerModelPolicyRevision =
        conversation.workerModelPolicy?.revision ?? "worker-harness-settings";
      const response = await input.adapter.completeTurn({
        conversation: conversation.messages,
        ownerInput: input.ownerInput,
        modelSelection,
        commitments: input.state.readCommitments(),
        nativeTools: { cwd: conversation.targetProject.path },
        standingOrders: orchestration.standingOrdersView(),
        authorityActions: {
          recordStandingOrder: (draft) => orchestration.recordStandingOrder(turnId, draft),
          revokeStandingOrder: (standingOrderId, reason) =>
            orchestration.revokeStandingOrder(standingOrderId, turnId, reason),
        },
        workers: orchestration.workerSessionsView(),
        workerQuestions: orchestration.workerQuestionsView(),
        harnessActions: {
          configure: (configuration) =>
            orchestration.configureWorkerHarness(turnId, configuration),
        },
        ...(!workerAvailable && (activeHarness || conversation.workerModelPolicy)
          ? {
              workerUnavailability: {
                nativeHarness: activeHarness ??
                  conversation.workerModelPolicy!.selection.nativeHarness,
                detail: workerDisabled
                  ? "The Owner disabled this harness; enable it again to delegate."
                  : input.workerSupervisor && !workerModel
                    ? "No Worker model is configured for the active harness; the Owner can set one conversationally."
                    : input.state.readCapabilityNotice("codex-worker")?.state === "active"
                      ? input.state.readCapabilityNotice("codex-worker")!.detail
                      : "The Worker capability could not be proven at start.",
              },
            }
          : {}),
        ...(workerAvailable
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
                    model: workerModel!,
                    modelPolicyRevision: workerModelPolicyRevision,
                  }),
                delegateReview: (assignment: {
                  implementationWorkerSessionId: string;
                  prompt: string;
                }) =>
                  input.workerSupervisor!.delegateReview({
                    ...assignment,
                    model: workerModel!,
                    modelPolicyRevision: workerModelPolicyRevision,
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
                        commitmentId?: string;
                        targets: string[];
                        recoveryOfWorkerSessionId?: string;
                        recoveryReason?: string;
                      }) => {
                        const commitmentId = assignment.commitmentId ??
                          orchestration.recordCommitment(turnId, {
                            outcome: assignment.objective,
                            criteria: [{
                              kind: "target-project-operation",
                              operation: "test",
                              description:
                                "The declared Target Project test operation verifies the delegated change.",
                            }],
                          }).id;
                        return input.workerSupervisor!.delegateEffectful({
                          ...assignment,
                          commitmentId,
                          targetProjectPath: conversation.targetProject.path,
                          model: workerModel!,
                          modelPolicyRevision: workerModelPolicyRevision,
                          timeoutMs: 20 * 60_000,
                          verification: {
                            operation: "test" as const,
                            workingDirectory: conversation.targetProject.path,
                            timeoutMs: 120_000,
                          },
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
          resume: (workItemId) => orchestration.resumeCommitment(workItemId, turnId),
          cancel: (workItemId, reason) =>
            orchestration.cancelCommitment(workItemId, turnId, reason),
          executeOperation: async (workItemId, operation) => {
            const commitmentId = workItemFor(
              workItemId,
              "The declared Target Project test operation passes.",
            );
            const result = await input.targetProjectOperations.execute({
              commitmentId,
              operation: { kind: operation, inputs: {} },
              checkout: conversation.targetProject.path,
              workingDirectory: conversation.targetProject.path,
              timeoutMs: 120_000,
            });
            orchestration.observeTargetProjectOperationResult(commitmentId, result);
            return result;
          },
        },
        forgeActions: {
          ...(conversation.forgeAuthorities?.github
            ? {
                commentOnGitHubIssue: async (operationInput) => {
                  const authority = conversation.forgeAuthorities!.github!;
                  const commitmentId = workItemFor(
                    operationInput.commitmentId,
                    `A bounded comment is published on ${authority.repository}#${operationInput.issueNumber}.`,
                    {
                      kind: "forge-operation",
                      operation: "github-issue-comment",
                      description: "The typed GitHub adapter proves the exact published comment.",
                    },
                  );
                  const result = await input.forgeOperations.execute({
                    commitmentId,
                    operation: {
                      kind: "github-issue-comment",
                      repository: authority.repository,
                      issueNumber: operationInput.issueNumber,
                      body: operationInput.body,
                      expectedAccount: authority.account,
                    },
                    timeoutMs: 30_000,
                  });
                  orchestration.observeForgeOperationResult(commitmentId, result);
                  return result;
                },
              }
            : {}),
          ...(conversation.forgeAuthorities?.azure
            ? {
                inspectAzureSubscription: async (workItemId) => {
                  const authority = conversation.forgeAuthorities!.azure!;
                  const commitmentId = workItemFor(
                    workItemId,
                    "The Azure subscription inspection completes.",
                    {
                      kind: "forge-operation",
                      operation: "azure-subscription-inspection",
                      description: "The typed Azure adapter proves the read-only inspection.",
                    },
                  );
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
