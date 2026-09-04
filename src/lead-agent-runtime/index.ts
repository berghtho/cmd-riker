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
  type OrchestrationCore,
} from "../orchestration-core/index.ts";
import {
  createTargetProjectOperations,
  type TargetProjectOperations,
} from "../target-project-operations/index.ts";
import type { WorkerSupervisor } from "../worker-supervisor/index.ts";
import { createLeadProjectScope } from "./project-scope.ts";
import { pendingLeadContinuations, type LeadContinuation, type LeadContinuationCandidate } from "../lead-continuation/index.ts";

export type LeadAgentRuntime = {
  completeOwnerTurn(
    ownerInput: string,
    onOwnerTurnRecorded?: (turnId: string) => void,
    sessionId?: string,
    signal?: AbortSignal,
  ): Promise<string>;
  completeContinuation(candidate: LeadContinuationCandidate, signal?: AbortSignal): Promise<string | undefined>;
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
    completeOwnerTurn: (ownerInput, onOwnerTurnRecorded, sessionId, signal) =>
      completeOwnerTurn({
        ...input,
        targetProjectOperations,
        forgeOperations,
        ownerInput,
        ...(onOwnerTurnRecorded ? { onOwnerTurnRecorded } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(signal ? { signal } : {}),
      }),
    async completeContinuation(candidate, signal) {
      if (signal?.aborted) return undefined;
      const current = pendingLeadContinuations(input.state).find((entry) => entry.eventKey === candidate.eventKey);
      if (!current) return undefined;
      const continuation = input.state.claimLeadContinuation(current);
      if (!continuation) return undefined;
      const boundedSignal = AbortSignal.any([
        AbortSignal.timeout(5 * 60_000),
        ...(signal ? [signal] : []),
      ]);
      try {
        const content = await completeOwnerTurn({
          ...input, targetProjectOperations, forgeOperations,
          ownerInput: input.state.ownerMessage(continuation.ownerTurnId)!,
          sessionId: continuation.sessionId,
          signal: boundedSignal,
          continuation,
        });
        input.state.settleLeadContinuation(continuation.id, "completed");
        return content;
      } catch (error) {
        input.state.settleLeadContinuation(continuation.id, "failed",
          signal?.aborted ? "aborted" : boundedSignal.aborted ? "turn-failed" :
            error instanceof LeadAgentRuntimeDiagnostic ? "model-unavailable" : "turn-failed");
        throw error;
      }
    },
  };
}

export function commitmentNotice(commitment: {
  id: string;
  outcome: string;
  state: string;
  condition?: { kind: string; nextAction?: string; ownerAttention?: string };
}): string {
  if (commitment.condition?.ownerAttention) {
    return (
      `Work item needs you: ${commitment.outcome}` +
      (commitment.condition.nextAction ? ` Next: ${commitment.condition.nextAction}` : "")
    );
  }
  const status = commitment.state === "accepted" || commitment.state === "awaiting-acceptance"
    ? "delivered"
    : commitment.condition?.kind ?? commitment.state;
  return (
    `Work item ${status}: ${commitment.outcome}` +
    (commitment.condition?.nextAction ? ` Next: ${commitment.condition.nextAction}` : "")
  );
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
  sessionId?: string;
  signal?: AbortSignal;
  continuation?: LeadContinuation;
}): Promise<string> {
  input.signal?.throwIfAborted();
  const conversation = input.state.readOwnerConversation(input.sessionId);
  if (!conversation) throw new Error("Authoritative state is not configured.");
  // A session bound to a configured project works in that checkout; unbound
  // sessions work in the default Target Project.
  const sessionProjectPath = input.sessionId
    ? input.state.readOwnerSessions().find((session) => session.id === input.sessionId)?.projectPath
    : undefined;
  const targetProjectPath = sessionProjectPath ?? conversation.targetProject.path;
  const project = createLeadProjectScope(input.state, targetProjectPath);
  const orchestration = createOrchestrationCore(input.state);
  const turnId = input.continuation?.ownerTurnId ?? input.state.appendOwnerMessage(input.ownerInput, input.sessionId);
  if (!input.continuation) input.onOwnerTurnRecorded?.(turnId);
  await reconcileUncertainForgeEffects(input.state, orchestration, input.forgeOperations, project);
  const commitmentsBefore = new Map(
    project
      .commitments()
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
  ): string => {
    if (workItemId) return project.requireCommitment(workItemId).id;
    return orchestration.recordCommitment(turnId, {
      outcome,
      criteria: [
        criterion ?? {
          kind: "target-project-operation",
          operation: "test",
          description: "The declared Target Project test operation verifies the outcome.",
        },
      ],
    }).id;
  };
  const candidates = [conversation.modelSelection, ...(conversation.modelFallbacks ?? [])];
  for (const [index, modelSelection] of candidates.entries()) {
    input.signal?.throwIfAborted();
    const validation = await input.adapter.validateSelection(
      modelSelection,
      conversation.modelRequirements ?? defaultLeadModelRequirements,
    );
    if (orchestration.modelCandidateDecision(validation) === "skip") continue;
    input.signal?.throwIfAborted();
    const attempt = orchestration.startLeadTurnAttempt({
      ownerTurnId: turnId,
      ...(input.continuation ? { continuationId: input.continuation.id } : {}),
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
        const worker = project.requireWorker(workerSessionId);
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
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.continuation ? { continuation: {
          kind: input.continuation.kind,
          workerSessionId: input.continuation.workerSessionId,
          ...(input.continuation.questionId ? { questionId: input.continuation.questionId } : {}),
          mission: input.ownerInput,
        } } : {}),
        modelSelection,
        commitments: project.commitments(),
        nativeTools: { cwd: targetProjectPath },
        standingOrders: orchestration.standingOrdersView().filter(project.containsStandingOrder),
        ...(!input.continuation ? { authorityActions: {
          recordStandingOrder: (draft) => {
            draft.commitmentIds.forEach(project.requireCommitment);
            return orchestration.recordStandingOrder(turnId, draft);
          },
          revokeStandingOrder: (standingOrderId, reason) => {
            project.requireStandingOrder(standingOrderId);
            orchestration.revokeStandingOrder(standingOrderId, turnId, reason);
          },
        } } : {}),
        workers: orchestration.workerSessionsView().filter(project.containsWorker),
        workerQuestions: orchestration.workerQuestionsView().filter(project.containsQuestion),
        ...(!input.continuation ? { harnessActions: {
          configure: (configuration) =>
            orchestration.configureWorkerHarness(turnId, configuration),
        } } : {}),
        ...(!workerAvailable && (unavailableHarness || conversation.workerModelPolicy)
          ? {
              workerUnavailability: {
                nativeHarness: unavailableHarness ??
                  conversation.workerModelPolicy!.selection.nativeHarness,
                detail: supervisors.size > 0
                  ? "No enabled harness has a configured Worker model; the Owner can set one conversationally."
                  : input.state.readCapabilityNotice("codex-worker", targetProjectPath)?.state === "active"
                    ? input.state.readCapabilityNotice("codex-worker", targetProjectPath)!.detail
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
                      if (assignment.commitmentId) project.requireCommitment(assignment.commitmentId);
                      if (assignment.recoveryOfWorkerSessionId) project.requireWorker(assignment.recoveryOfWorkerSessionId);
                      return supervisor.delegate({
                        ...bounded,
                        ownerTurnId: turnId,
                        targetProjectPath: targetProjectPath,
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
                            if (assignment.recoveryOfWorkerSessionId) project.requireWorker(assignment.recoveryOfWorkerSessionId);
                            const commitmentId = workItemFor(
                              assignment.commitmentId,
                              assignment.objective,
                            );
                            return supervisor.delegateEffectful({
                              ...bounded,
                              ownerTurnId: turnId,
                              commitmentId,
                              targetProjectPath: targetProjectPath,
                              model: model ?? modelFor(harness)!,
                              modelPolicyRevision: workerModelPolicyRevision,
                              timeoutMs: (timeoutMinutes ?? 20) * 60_000,
                              verification: {
                                operation: "test" as const,
                                workingDirectory: targetProjectPath,
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
                  project.requireWorker(assignment.implementationWorkerSessionId);
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
                adjudicateReview: (adjudication) => {
                  project.requireCommitment(adjudication.commitmentId);
                  orchestration.adjudicateReview(adjudication.commitmentId, adjudication.decisions);
                },
                reserveOwnerDecision: (questionId: string, reason: string) => {
                  project.requireQuestion(questionId);
                  orchestration.reserveWorkerQuestionForOwner(questionId, reason);
                },
                steer: async (workerSessionId: string, message: string) =>
                  supervisorOfWorker(workerSessionId).steer(workerSessionId, message),
                workerOutput: (workerSessionId: string) => {
                  project.requireWorker(workerSessionId);
                  try {
                    return supervisorOfWorker(workerSessionId).workerOutput(workerSessionId);
                  } catch {
                    return undefined;
                  }
                },
                answer: (questionId: string, answers: Record<string, string[]>) => {
                  const question = project.requireQuestion(questionId);
                  if (input.continuation && question.ownerAttention) {
                    throw new Error("This Worker question is reserved for the Owner.");
                  }
                  return supervisorOfWorker(question.workerSessionId)
                    .answer(questionId, turnId, answers);
                },
                cancel: (workerSessionId: string, reason: string) =>
                  supervisorOfWorker(workerSessionId).cancel(workerSessionId, turnId, reason),
              },
            }
          : {}),
        commitmentActions: {
          resume: (workItemId) => {
            project.requireCommitment(workItemId);
            orchestration.resumeCommitment(workItemId, turnId);
          },
          ...(!input.continuation ? { cancel: (workItemId: string, reason: string) => {
            project.requireCommitment(workItemId);
            orchestration.cancelCommitment(workItemId, turnId, reason);
          },
          recordOwnerVerdict: async (workItemId: string, ownerVerdictQuote: string) => {
            project.requireCommitment(workItemId);
            const targetProjectHeadCommit = await readTargetProjectHead(
              targetProjectPath,
            );
            return orchestration.recordOwnerVerdict(workItemId, turnId, {
              ownerVerdictQuote,
              ...(targetProjectHeadCommit ? { targetProjectHeadCommit } : {}),
            });
          } } : {}),
          executeOperation: async (workItemId, operation) => {
            const commitmentId = workItemFor(
              workItemId,
              "The declared Target Project test operation passes.",
            );
            const result = await input.targetProjectOperations.execute({
              commitmentId,
              operation: { kind: operation, inputs: {} },
              checkout: targetProjectPath,
              workingDirectory: targetProjectPath,
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
      const pendingSelfRepairAccounts = input.state.readSelfRepairs()
        .filter((repair) => project.containsCommitmentId(repair.commitmentId)).flatMap((repair) =>
        repair.attempts.flatMap((repairAttempt) =>
          repairAttempt.activation && !repairAttempt.activation.deliveredAt
            ? [{ repair, attempt: repairAttempt, account: repairAttempt.activation.account }]
            : []
        )
      );
      const pendingCommitmentAccounts = project.commitments().filter(
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
      const appendResponse = input.continuation
        ? input.state.appendLeadContinuationMessageWithAccounts.bind(input.state)
        : input.state.appendLeadAgentMessageWithAccounts.bind(input.state);
      appendResponse(
        input.continuation?.id ?? turnId,
        durableResponse,
        { selfRepairs: deliveredRepairs, commitments: deliveredCommitments },
        {
          modelSelection,
          modelPolicyRevision: conversation.modelPolicyRevision,
          ...(index > 0
            ? { selectionReason: "fallback-after-ineligible-candidate" as const }
            : {}),
          ...(response.metrics ? { turnMetrics: response.metrics } : {}),
        },
      );
      orchestration.observeLeadResponse(turnId, durableResponse);
      const notices = project
        .commitments()
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
      const failureKind = input.signal?.aborted ? "aborted" : error instanceof PiTurnFailure ? error.kind : "turn-failed";
      orchestration.settleLeadTurnAttempt(attempt.id, "failed", failureKind);
      if (failureKind === "aborted") {
        throw new LeadAgentRuntimeDiagnostic("CMD_RIKER_LEAD_INTERRUPTED", "Lead turn interrupted. Completed effects remain in place; Worker Sessions continue.");
      }
      if (!(error instanceof PiTurnFailure)) throw error;
      const decision = orchestration.modelFailureDecision(error);
      if (decision === "fallback") continue;
      if (decision === "revalidate") {
        const updatedValidation = await input.adapter.validateSelection(
          modelSelection,
          conversation.modelRequirements ?? defaultLeadModelRequirements,
        );
        if (orchestration.modelCandidateDecision(updatedValidation) === "skip") continue;
      }
      if (!input.continuation) orchestration.observeLeadTurnFailure(turnId, `Lead Model turn failed: ${error.kind}.`);
      break;
    }
  }
  throw new LeadAgentRuntimeDiagnostic(
    "CMD_RIKER_MODEL_UNAVAILABLE",
    "The configured Model did not complete the turn.",
  );
}

const execFileAsync = promisify(execFile);

// An idempotent Forge mutation whose confirmation was lost must not trap its
// Commitment: the provider is re-observed and the effect settles on that
// evidence. A failed re-observation leaves the effect uncertain — honesty
// over guessing.
async function reconcileUncertainForgeEffects(
  state: AuthoritativeState,
  orchestration: OrchestrationCore,
  forgeOperations: ForgeOperations,
  project: ReturnType<typeof createLeadProjectScope>,
): Promise<void> {
  for (const effect of state.readEffectIntents()) {
    if (effect.kind !== "forge-operation" || effect.status !== "unknown") continue;
    if (!project.containsCommitmentId(effect.commitmentId)) continue;
    const attempt = state.readForgeOperationAttempt(effect.forgeOperationAttemptId);
    if (!attempt || !project.containsCommitmentId(attempt.commitmentId)) continue;
    try {
      const readBack = await forgeOperations.readBackEffect({
        target: attempt.target,
        expectedAccount: attempt.expectedAccount,
        timeoutMs: 30_000,
      });
      orchestration.reconcileForgeEffect({
        effectIntentId: effect.id,
        applied: readBack.applied,
        evidence: readBack.evidence,
      });
    } catch {
      // The effect stays uncertain until a read-back succeeds.
    }
  }
}

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
