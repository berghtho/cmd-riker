import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export type WorkerSupervisors = Partial<
  Record<"codex" | "claude" | "copilot", WorkerSupervisor>
>;

export function createLeadAgentRuntime(input: {
  state: AuthoritativeState;
  adapter: PiTurnAdapter;
  workerSupervisor?: WorkerSupervisor;
  workerSupervisors?: WorkerSupervisors;
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
  workerSupervisors?: WorkerSupervisors;
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
          operation:
            | "github-issue-comment"
            | "github-issue-close"
            | "github-issue-label-remove"
            | "azure-subscription-inspection";
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
      const harnessSettings = conversation.workerHarnessSettings ?? {};
      const workerModelPolicyRevision =
        conversation.workerModelPolicy?.revision ?? "worker-harness-settings";
      const supervisors = new Map<"codex" | "claude" | "copilot", WorkerSupervisor>();
      const register = (supervisor: WorkerSupervisor | undefined): void => {
        if (!supervisor) return;
        const harness = supervisor.capabilities().nativeHarness;
        if (!supervisors.has(harness)) supervisors.set(harness, supervisor);
      };
      register(input.workerSupervisor);
      for (const supervisor of Object.values(input.workerSupervisors ?? {})) register(supervisor);
      const modelFor = (harness: "codex" | "claude" | "copilot"): string | undefined =>
        harnessSettings[harness]?.model ??
        (conversation.workerModelPolicy?.selection.nativeHarness === harness
          ? conversation.workerModelPolicy.selection.model
          : undefined);
      const availableHarnesses = [...supervisors.entries()].filter(
        ([harness]) => harnessSettings[harness]?.enabled !== false && modelFor(harness),
      );
      const supervisorOfWorker = (workerSessionId: string): WorkerSupervisor => {
        const worker = orchestration.workerSessionView(workerSessionId);
        const attempt = worker
          ? orchestration.workerExecutionAttemptView(worker.currentExecutionAttemptId)
          : undefined;
        const supervisor = attempt
          ? supervisors.get(attempt.modelSelection.nativeHarness)
          : undefined;
        if (!supervisor) {
          throw new Error("This Worker's Native Harness is not available in this session.");
        }
        return supervisor;
      };
      const workerAvailable = availableHarnesses.length > 0;
      const firstSupervisor = supervisors.values().next().value as WorkerSupervisor | undefined;
      const unavailableHarness = firstSupervisor?.capabilities().nativeHarness ??
        conversation.workerModelPolicy?.selection.nativeHarness;
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
        ...(!workerAvailable && (unavailableHarness || conversation.workerModelPolicy)
          ? {
              workerUnavailability: {
                nativeHarness: unavailableHarness ??
                  conversation.workerModelPolicy!.selection.nativeHarness,
                detail: supervisors.size > 0
                  ? "No enabled harness has a configured Worker model; the Owner can set one conversationally."
                  : input.state.readCapabilityNotice("codex-worker")?.state === "active"
                    ? input.state.readCapabilityNotice("codex-worker")!.detail
                    : "The Worker capability could not be proven at start.",
              },
            }
          : {}),
        ...(workerAvailable
          ? {
              workerActions: {
                harnesses: availableHarnesses.map(([harness, supervisor]) => {
                  const capabilities = supervisor.capabilities();
                  return {
                    nativeHarness: harness,
                    effectful: capabilities.effectful,
                    nativeQuestions: capabilities.nativeQuestions,
                    cancellation: capabilities.cancellation,
                    delegate: (assignment: {
                      objective: string;
                      prompt: string;
                      model?: string;
                      commitmentId?: string;
                      recoveryOfWorkerSessionId?: string;
                      recoveryReason?: string;
                    }) => {
                      const { model, ...bounded } = assignment;
                      return supervisor.delegate({
                        ...bounded,
                        targetProjectPath: conversation.targetProject.path,
                        model: model ?? modelFor(harness)!,
                        modelPolicyRevision: workerModelPolicyRevision,
                      });
                    },
                    ...(capabilities.effectful
                      ? {
                          delegateEffectful: (assignment: {
                            objective: string;
                            prompt: string;
                            model?: string;
                            commitmentId?: string;
                            targets: string[];
                            timeoutMinutes?: number;
                            recoveryOfWorkerSessionId?: string;
                            recoveryReason?: string;
                          }) => {
                            const { model, timeoutMinutes, ...bounded } = assignment;
                            const commitmentId = workItemFor(
                              assignment.commitmentId,
                              assignment.objective,
                            );
                            return supervisor.delegateEffectful({
                              ...bounded,
                              commitmentId,
                              targetProjectPath: conversation.targetProject.path,
                              model: model ?? modelFor(harness)!,
                              modelPolicyRevision: workerModelPolicyRevision,
                              timeoutMs: (timeoutMinutes ?? 20) * 60_000,
                              verification: {
                                operation: "test" as const,
                                workingDirectory: conversation.targetProject.path,
                                timeoutMs: 15 * 60_000,
                              },
                            });
                          },
                        }
                      : {}),
                  };
                }),
                delegateReview: (assignment: {
                  implementationWorkerSessionId: string;
                  prompt: string;
                  harness?: "codex" | "claude" | "copilot";
                }) => {
                  const { harness, ...bounded } = assignment;
                  const chosen = (harness && supervisors.get(harness)) ??
                    availableHarnesses[0]?.[1];
                  if (!chosen) throw new Error("No Worker harness is available for Review.");
                  const chosenHarness = chosen.capabilities().nativeHarness;
                  return chosen.delegateReview({
                    ...bounded,
                    model: modelFor(chosenHarness) ?? conversation.workerModelPolicy!.selection.model,
                    modelPolicyRevision: workerModelPolicyRevision,
                  });
                },
                adjudicateReview: (adjudication) =>
                  orchestration.adjudicateReview(adjudication.commitmentId, adjudication.decisions),
                reserveOwnerDecision: (questionId: string, reason: string) => {
                  orchestration.reserveWorkerQuestionForOwner(questionId, reason);
                },
                steer: async (workerSessionId: string, message: string) =>
                  supervisorOfWorker(workerSessionId).steer(workerSessionId, message),
                workerOutput: (workerSessionId: string) => {
                  try {
                    return supervisorOfWorker(workerSessionId).workerOutput(workerSessionId);
                  } catch {
                    return undefined;
                  }
                },
                answer: (questionId: string, answers: Record<string, string[]>) => {
                  const question = orchestration
                    .workerQuestionsView()
                    .find((candidate) => candidate.id === questionId);
                  if (!question) throw new Error("Unknown Worker question.");
                  return supervisorOfWorker(question.workerSessionId)
                    .answer(questionId, turnId, answers);
                },
                cancel: (workerSessionId: string, reason: string) =>
                  supervisorOfWorker(workerSessionId).cancel(workerSessionId, turnId, reason),
              },
            }
          : {}),
        commitmentActions: {
          resume: (workItemId) => orchestration.resumeCommitment(workItemId, turnId),
          cancel: (workItemId, reason) =>
            orchestration.cancelCommitment(workItemId, turnId, reason),
          recordOwnerVerdict: async (workItemId, ownerVerdictQuote) => {
            const targetProjectHeadCommit = await readTargetProjectHead(
              conversation.targetProject.path,
            );
            return orchestration.recordOwnerVerdict(workItemId, turnId, {
              ownerVerdictQuote,
              ...(targetProjectHeadCommit ? { targetProjectHeadCommit } : {}),
            });
          },
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
              timeoutMs: 15 * 60_000,
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
                closeGitHubIssue: async (operationInput) => {
                  const authority = conversation.forgeAuthorities!.github!;
                  const stateReason = operationInput.stateReason ?? "completed";
                  const commitmentId = workItemFor(
                    operationInput.commitmentId,
                    `Issue ${authority.repository}#${operationInput.issueNumber} is closed (${stateReason}).`,
                    {
                      kind: "forge-operation",
                      operation: "github-issue-close",
                      description: "The typed GitHub adapter proves the closed issue by read-back.",
                    },
                  );
                  const result = await input.forgeOperations.execute({
                    commitmentId,
                    operation: {
                      kind: "github-issue-close",
                      repository: authority.repository,
                      issueNumber: operationInput.issueNumber,
                      stateReason,
                      expectedAccount: authority.account,
                    },
                    timeoutMs: 30_000,
                  });
                  orchestration.observeForgeOperationResult(commitmentId, result);
                  return result;
                },
                removeGitHubIssueLabel: async (operationInput) => {
                  const authority = conversation.forgeAuthorities!.github!;
                  const commitmentId = workItemFor(
                    operationInput.commitmentId,
                    `Label "${operationInput.label}" is removed from ${authority.repository}#${operationInput.issueNumber}.`,
                    {
                      kind: "forge-operation",
                      operation: "github-issue-label-remove",
                      description: "The typed GitHub adapter proves the absent label by read-back.",
                    },
                  );
                  const result = await input.forgeOperations.execute({
                    commitmentId,
                    operation: {
                      kind: "github-issue-label-remove",
                      repository: authority.repository,
                      issueNumber: operationInput.issueNumber,
                      label: operationInput.label,
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

const execFileAsync = promisify(execFile);

// An Owner verdict is worth recording even when the Target Project head cannot
// be read; the pin is dropped rather than the acceptance.
async function readTargetProjectHead(targetProjectPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", targetProjectPath, "rev-parse", "HEAD"],
      { timeout: 10_000, windowsHide: true },
    );
    const head = stdout.trim();
    return /^[0-9a-f]{40,64}$/i.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

function commitmentFingerprint(commitment: {
  state: string;
  condition?: { kind: string };
}): string {
  return `${commitment.state}:${commitment.condition?.kind ?? "none"}`;
}
