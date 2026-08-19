import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  Input,
  Key,
  matchesKey,
  ProcessTerminal,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";

import {
  completeAuthoritativeStateRecovery,
  establishNewAuthoritativeStateBaseline,
  openAuthoritativeStateSafely,
  reconcilePostBackupEffect,
  restoreAuthoritativeStateBackup,
  type AuthoritativeState,
  type OwnerConfiguration,
  type PostBackupEffectInventory,
  type PostBackupEffectReconciliation,
} from "./authoritative-state/index.ts";
import {
  PiAgentTurnAdapter,
  PiTurnFailure,
  type PiTurnAdapter,
} from "./conversation-runtime/index.ts";
import {
  assertSupportedModelSelection,
  type ModelSelection,
} from "./model-selection.ts";
import {
  assertSupportedWorkerModelSelection,
  assertValidatedLeadModelPolicy,
  createOrchestrationCore,
  defaultLeadModelRequirements,
  type LeadModelRequirements,
  type LeadModelPolicy,
  type ActingAuthorityEffectRequest,
} from "./orchestration-core/index.ts";
import {
  createClaudeWorkerHarness,
  createCodexWorkerHarness,
  createCopilotWorkerHarness,
  createWorkerSupervisor,
  resolveClaudeRuntime,
  resolveCodexRuntime,
  resolveCopilotRuntime,
  type NativeWorkerHarness,
  type WorkerSupervisor,
} from "./worker-supervisor/index.ts";
import { createTargetProjectOperations } from "./target-project-operations/index.ts";
import { createForgeOperations } from "./forge-operations/index.ts";
import {
  parseSessionViewControl,
  parseSessionViewInspection,
  parseSessionViewWorkerInspection,
  projectSessionView,
  renderSessionView,
  renderSessionWorkers,
  type SessionViewSnapshot,
} from "./session-view/index.ts";

async function main(): Promise<void> {
  const stateDirectory = argumentValue("--state-dir");
  if (!stateDirectory) throw new Error("--state-dir is required.");

  const restoreBackupPath = argumentValue("--restore-state-backup");
  const reconciliationPath = argumentValue("--reconcile-post-backup-effect");
  const completeRecovery = process.argv.includes("--complete-state-recovery");
  const establishNewBaseline = process.argv.includes("--establish-new-state-baseline");
  const recoveryActionCount = [
    Boolean(restoreBackupPath),
    Boolean(reconciliationPath),
    completeRecovery,
    establishNewBaseline,
  ].filter(Boolean).length;
  if (recoveryActionCount > 1) {
    throw new HostDiagnostic(
      "CMD_RIKER_STATE_RECOVERY_ACTION_INVALID",
      "Choose exactly one Authoritative State recovery action.",
    );
  }
  if (restoreBackupPath) {
    const inventoryPath = argumentValue("--post-backup-inventory");
    if (!inventoryPath) {
      throw new HostDiagnostic(
        "CMD_RIKER_STATE_RECOVERY_INPUT_INVALID",
        "--restore-state-backup requires --post-backup-inventory.",
      );
    }
    const inventory = await readJsonFile(inventoryPath) as PostBackupEffectInventory;
    try {
      const recovery = restoreAuthoritativeStateBackup({
        stateDirectory,
        backupPath: restoreBackupPath,
        postBackupInventory: inventory,
      });
      process.stdout.write(
        `CMD_RIKER_STATE_BACKUP_RESTORED: Mutations remain disabled; ` +
          `${recovery.postBackupInventory?.effects.length ?? 0} possible later effects require reconciliation.\n`,
      );
      return;
    } catch (error) {
      throw recoveryFailure(error);
    }
  }
  if (reconciliationPath) {
    const input = await readJsonFile(reconciliationPath) as Pick<
      PostBackupEffectReconciliation,
      "effectId" | "disposition" | "evidence"
    >;
    try {
      reconcilePostBackupEffect({ stateDirectory, ...input });
      process.stdout.write(
        `CMD_RIKER_POST_BACKUP_EFFECT_RECONCILED: ${input.effectId} is settled from external evidence.\n`,
      );
      return;
    } catch (error) {
      throw recoveryFailure(error);
    }
  }
  if (completeRecovery) {
    try {
      completeAuthoritativeStateRecovery(stateDirectory);
      process.stdout.write(
        "CMD_RIKER_STATE_RECOVERY_COMPLETED: Authoritative State mutations are enabled.\n",
      );
      return;
    } catch (error) {
      throw recoveryFailure(error);
    }
  }
  if (establishNewBaseline) {
    const ownerConfirmation = argumentValue("--owner-confirmation");
    const configuration = await readConfiguration(stateDirectory);
    try {
      establishNewAuthoritativeStateBaseline({
        stateDirectory,
        configuration,
        ownerConfirmation: ownerConfirmation ?? "",
      });
      process.stdout.write(
        "CMD_RIKER_NEW_STATE_BASELINE_ESTABLISHED: Damaged history remains recovery evidence.\n",
      );
      return;
    } catch (error) {
      throw recoveryFailure(error);
    }
  }

  const openedState = openAuthoritativeStateSafely(stateDirectory);
  if (openedState.kind === "recovery-required") {
    throw new HostDiagnostic(
      "CMD_RIKER_STATE_RECOVERY_REQUIRED",
      "Authoritative State integrity is not trusted; product mutations are disabled. " +
        `Damaged evidence is preserved at ${openedState.recovery.damagedEvidenceDirectory}. ` +
        "Use --restore-state-backup with --post-backup-inventory, then " +
        "--reconcile-post-backup-effect and --complete-state-recovery; without a trusted backup, " +
        "use --establish-new-state-baseline with explicit --owner-confirmation. " +
        `Observed failure: ${openedState.recovery.reason}`,
    );
  }
  const state = openedState.state;
  const backupPath = argumentValue("--create-state-backup");
  if (backupPath) {
    try {
      const backup = await state.createBackup(backupPath);
      process.stdout.write(
        `CMD_RIKER_STATE_BACKUP_CREATED: ${backup.databasePath} sha256=${backup.sha256}\n`,
      );
      return;
    } catch (error) {
      throw recoveryFailure(error);
    } finally {
      state.close();
    }
  }
  const adapter: PiTurnAdapter = new PiAgentTurnAdapter();
  try {
    let policyValidated = false;
    let conversation = state.readOwnerConversation();
    const configuration = await readStartupConfiguration(stateDirectory, !conversation);
    if (configuration) {
      if (!conversation) {
        await validatePolicy(adapter, configuration);
        policyValidated = true;
      }
      state.initialize(configuration);
      conversation = state.readOwnerConversation();
    }
    if (!conversation) throw new Error("Authoritative state could not be initialized.");
    createOrchestrationCore(state).reconcileInterruptedCommitments();
    if (!policyValidated) await validatePolicy(adapter, conversation);
    const workerSupervisor = await availableWorkerSupervisor(state, conversation);
    if (workerSupervisor) await workerSupervisor.recover();

    if (process.stdin.isTTY && process.stdout.isTTY) {
      await runInteractiveConversation(
        state,
        adapter,
        conversation.targetProject.path,
        workerSupervisor,
      );
    } else {
      await runScriptableConversation(
        state,
        adapter,
        conversation.targetProject.path,
        workerSupervisor,
      );
    }
  } finally {
    state.close();
  }
}

async function runScriptableConversation(
  state: AuthoritativeState,
  adapter: PiTurnAdapter,
  targetProjectPath: string,
  workerSupervisor: WorkerSupervisor | undefined,
): Promise<void> {
  process.stdout.write(`CMD Riker | Target Project: ${targetProjectPath}\n`);
  process.stdout.write(`${currentSessionView(state, workerSupervisor)}\n`);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const ownerInput of lines) {
    if (!ownerInput.trim()) continue;
    const output = await completeOwnerInteraction(
      state,
      adapter,
      ownerInput,
      workerSupervisor,
    );
    process.stdout.write(`${output.source}: ${output.content}\n`);
    process.stdout.write(`${currentSessionView(state, workerSupervisor)}\n`);
  }
}

function runInteractiveConversation(
  state: AuthoritativeState,
  adapter: PiTurnAdapter,
  targetProjectPath: string,
  workerSupervisor: WorkerSupervisor | undefined,
): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const conversation = state.readOwnerConversation();
  const transcriptLines = (conversation?.messages ?? []).map((message) =>
    `${message.role === "owner" ? "Owner" : "Lead Agent"}: ${message.content}`,
  );
  transcriptLines.push(...state.readCommitments().map(commitmentNotice));
  const transcript = new Text(transcriptLines.join("\n\n"));
  const sessionView = new Text(currentSessionView(state, workerSupervisor));
  const input = new Input();
  let busy = false;
  let stopRequested = false;

  tui.addChild(new Text(`CMD Riker | Target Project: ${targetProjectPath}`));
  tui.addChild(transcript);
  tui.addChild(sessionView);
  tui.addChild(new Text("Owner:"));
  tui.addChild(input);
  tui.setFocus(input);

  return new Promise((resolve, reject) => {
    let renderedSessionView = currentSessionView(state, workerSupervisor);
    const refreshSessionView = () => {
      const next = currentSessionView(
        state,
        workerSupervisor,
        busy ? "responding" : "available",
      );
      if (next === renderedSessionView) return;
      renderedSessionView = next;
      sessionView.setText(next);
      tui.requestRender();
    };
    const refreshTimer = setInterval(refreshSessionView, 250);
    const stop = () => {
      if (busy) {
        stopRequested = true;
        return;
      }
      clearInterval(refreshTimer);
      tui.stop();
      resolve();
    };
    tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        stop();
        return { consume: true };
      }
      return undefined;
    });
    input.onSubmit = (ownerInput) => {
      if (busy || !ownerInput.trim()) return;
      busy = true;
      input.setValue("");
      transcriptLines.push(`Owner: ${ownerInput}`, "Lead Agent: thinking...");
      transcript.setText(transcriptLines.join("\n\n"));
      refreshSessionView();
      tui.requestRender();
      void completeOwnerInteraction(state, adapter, ownerInput, workerSupervisor)
        .then((output) => {
          transcriptLines[transcriptLines.length - 1] = `${output.source}: ${output.content}`;
          transcript.setText(transcriptLines.join("\n\n"));
          busy = false;
          refreshSessionView();
          if (stopRequested) stop();
          else tui.requestRender();
        })
        .catch((error: unknown) => {
          clearInterval(refreshTimer);
          tui.stop();
          reject(error);
        });
    };
    input.onEscape = stop;
    tui.start();
  });
}

type OwnerInteractionOutput = {
  source: "Lead Agent" | "Session View";
  content: string;
};

async function completeOwnerInteraction(
  state: AuthoritativeState,
  adapter: PiTurnAdapter,
  ownerInput: string,
  workerSupervisor?: WorkerSupervisor,
): Promise<OwnerInteractionOutput> {
  if (!/^\/session\s+/i.test(ownerInput)) {
    return {
      source: "Lead Agent",
      content: await completeOwnerTurn(state, adapter, ownerInput, workerSupervisor),
    };
  }
  const snapshot = sessionViewSnapshot(state, workerSupervisor);
  if (/^\/session\s+workers\s*$/i.test(ownerInput)) {
    return {
      source: "Session View",
      content: renderSessionWorkers(snapshot),
    };
  }
  const workerInspection = parseSessionViewWorkerInspection(snapshot, ownerInput);
  if (workerInspection) {
    return {
      source: "Session View",
      content: renderSessionWorkers(snapshot, workerInspection.id),
    };
  }
  const inspection = parseSessionViewInspection(snapshot, ownerInput);
  if (inspection) {
    const detailedSnapshot = sessionViewSnapshot(
      state,
      workerSupervisor,
      "available",
      true,
    );
    return {
      source: "Session View",
      content: renderSessionView(detailedSnapshot, inspection.id),
    };
  }
  const action = parseSessionViewControl(snapshot, ownerInput);
  if (!action) {
    return {
      source: "Session View",
      content: "That intervention is not available for the current authoritative state.",
    };
  }
  const ownerTurnId = state.appendOwnerMessage(ownerInput);
  if (action.kind === "pause") {
    createOrchestrationCore(state).pauseCommitment(
      action.targetId,
      ownerTurnId,
      "Owner requested a pause from the Session View.",
    );
    return {
      source: "Session View",
      content: "Pause recorded. Linked Worker activity and any effects remain separate facts.",
    };
  }
  if (!workerSupervisor) throw new Error("Session View exposed cancellation without a live Worker supervisor.");
  await workerSupervisor.cancel(
    action.targetId,
    ownerTurnId,
    "Owner requested cancellation from the Session View.",
  );
  return {
    source: "Session View",
    content: "Cancellation intent recorded and sent. Existing effects are not rolled back.",
  };
}

function currentSessionView(
  state: AuthoritativeState,
  workerSupervisor?: WorkerSupervisor,
  leadAvailability: SessionViewSnapshot["leadAvailability"] = "available",
): string {
  return renderSessionView(sessionViewSnapshot(state, workerSupervisor, leadAvailability));
}

function sessionViewSnapshot(
  state: AuthoritativeState,
  workerSupervisor?: WorkerSupervisor,
  leadAvailability: SessionViewSnapshot["leadAvailability"] = "available",
  includeHealthAssessments = false,
): SessionViewSnapshot {
  return projectSessionView(state, {
    leadAvailability,
    cancellationAvailable: Boolean(workerSupervisor),
    includeHealthAssessments,
  });
}

async function completeOwnerTurn(
  state: AuthoritativeState,
  adapter: PiTurnAdapter,
  ownerInput: string,
  workerSupervisor?: WorkerSupervisor,
): Promise<string> {
  const conversation = state.readOwnerConversation();
  if (!conversation) throw new Error("Authoritative state is not configured.");
  const orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage(ownerInput);
  const commitmentsBefore = new Map(
    state
      .readCommitments()
      .map((commitment) => [commitment.id, commitmentFingerprint(commitment)]),
  );
  const candidates = [conversation.modelSelection, ...(conversation.modelFallbacks ?? [])];
  for (const [index, modelSelection] of candidates.entries()) {
    const validation = await adapter.validateSelection(
      modelSelection,
      conversation.modelRequirements ?? defaultLeadModelRequirements,
    );
    if (orchestration.modelCandidateDecision(validation) === "skip") continue;
    const attempt = orchestration.startLeadTurnAttempt({
      ownerTurnId: turnId,
      modelSelection,
      modelPolicyRevision: conversation.modelPolicyRevision,
      ...(index > 0
        ? { selectionReason: "fallback-after-ineligible-candidate" as const }
        : {}),
    });
    try {
      const workerCapabilities = workerSupervisor?.capabilities();
      const response = await adapter.completeTurn({
        conversation: conversation.messages,
        ownerInput,
        modelSelection,
        commitments: state.readCommitments(),
        standingOrders: orchestration.standingOrdersView(),
        ...(orchestration.actingAuthorityView()
          ? { actingAuthority: orchestration.actingAuthorityView()! }
          : {}),
        authorityActions: {
          recordStandingOrder: (draft) => orchestration.recordStandingOrder(turnId, draft),
          revokeStandingOrder: (standingOrderId, reason) =>
            orchestration.revokeStandingOrder(standingOrderId, turnId, reason),
          beginActingAuthority: (input) => orchestration.beginActingAuthority(turnId, input),
          recordActingAuthorityEvent: (actingAuthorityId, input) =>
            orchestration.recordActingAuthorityEvent(actingAuthorityId, input),
          prepareActingAuthorityHandoff: (actingAuthorityId) =>
            orchestration.prepareActingAuthorityHandoff(actingAuthorityId, turnId),
        },
        workers: orchestration.workerSessionsView(),
        workerQuestions: orchestration.workerQuestionsView(),
        ...(workerSupervisor
          ? {
              workerActions: {
                capabilities: {
                  nativeHarness: workerCapabilities!.nativeHarness,
                  effectful: workerCapabilities!.effectful,
                  nativeQuestions: workerCapabilities!.nativeQuestions,
                  cancellation: workerCapabilities!.cancellation,
                },
                delegate: (input: {
                  objective: string;
                  prompt: string;
                  commitmentId?: string;
                  recoveryOfWorkerSessionId?: string;
                  recoveryReason?: string;
                }) =>
                  workerSupervisor.delegate({
                    ...input,
                    targetProjectPath: conversation.targetProject.path,
                    model: conversation.workerModelPolicy!.selection.model,
                    modelPolicyRevision: conversation.workerModelPolicy!.revision,
                  }),
                delegateReview: (input: {
                  implementationWorkerSessionId: string;
                  prompt: string;
                }) =>
                  workerSupervisor.delegateReview({
                    ...input,
                    model: conversation.workerModelPolicy!.selection.model,
                    modelPolicyRevision: conversation.workerModelPolicy!.revision,
                  }),
                adjudicateReview: (input) =>
                  orchestration.adjudicateReview(input.commitmentId, input.decisions),
                reserveOwnerDecision: (questionId: string, reason: string) => {
                  orchestration.reserveWorkerQuestionForOwner(questionId, reason);
                },
                ...(workerCapabilities!.effectful
                  ? {
                      delegateEffectful: (input: {
                        objective: string;
                        prompt: string;
                        commitmentId: string;
                        targets: string[];
                        actingAuthorityEffect?: ActingAuthorityEffectRequest;
                      }) => {
                        const { actingAuthorityEffect, ...assignment } = input;
                        const authorization = actingAuthorityEffect
                          ? orchestration.authorizeActingAuthorityEffect(actingAuthorityEffect)
                          : undefined;
                        return workerSupervisor.delegateEffectful({
                          ...assignment,
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
                        workerSupervisor.answer(questionId, turnId, answers),
                    }
                  : {}),
                ...(workerCapabilities!.cancellation
                  ? {
                      cancel: (workerSessionId: string, reason: string) =>
                        workerSupervisor.cancel(workerSessionId, turnId, reason),
                    }
                  : {}),
              },
            }
          : {}),
        commitmentActions: {
          record: (draft) => orchestration.recordCommitment(turnId, draft),
          recordOwnerAttention: (commitmentId, input) => {
            orchestration.recordCommitmentOwnerAttention(commitmentId, input);
          },
          accept: (commitmentId) => orchestration.acceptCommitment(commitmentId, turnId),
          resume: (commitmentId) => orchestration.resumeCommitment(commitmentId, turnId),
          control: (commitmentId, action, reason, replacementCommitmentId) => {
            if (action === "pause") orchestration.pauseCommitment(commitmentId, turnId, reason);
            else if (action === "cancel") {
              orchestration.cancelCommitment(commitmentId, turnId, reason);
            } else {
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
            const result = await createTargetProjectOperations(state).execute({
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
          ...(conversation.forgeAuthorities?.github ? { commentOnGitHubIssue: async (input, actingAuthorityEffect) => {
            const authority = conversation.forgeAuthorities!.github!;
            const authorization = orchestration.authorizeActingAuthorityEffect(actingAuthorityEffect);
            const result = await createForgeOperations(state).execute({
              commitmentId: input.commitmentId,
              operation: {
                kind: "github-issue-comment",
                repository: authority.repository,
                issueNumber: input.issueNumber,
                body: input.body,
                expectedAccount: authority.account,
              },
              timeoutMs: 30_000,
              actingAuthorityEffectAuthorization: {
                actingAuthorityId: authorization.actingAuthorityId,
                authorizationId: authorization.id,
                standingOrderId: authorization.standingOrderId,
              },
            });
            orchestration.observeForgeOperationResult(input.commitmentId, result);
            return result;
          } } : {}),
          ...(conversation.forgeAuthorities?.azure ? { inspectAzureSubscription: async (commitmentId) => {
            const authority = conversation.forgeAuthorities!.azure!;
            const result = await createForgeOperations(state).execute({
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
          } } : {}),
        },
      });
      state.appendLeadAgentMessage(turnId, response.content, {
        modelSelection,
        modelPolicyRevision: conversation.modelPolicyRevision,
        ...(index > 0
          ? { selectionReason: "fallback-after-ineligible-candidate" as const }
          : {}),
      });
      orchestration.observeLeadResponse(turnId, response.content);
      const notices = state
        .readCommitments()
        .filter(
          (commitment) =>
            commitmentsBefore.get(commitment.id) !== commitmentFingerprint(commitment),
        )
        .map(commitmentNotice);
      const content = notices.length
        ? `${response.content}\n\n${notices.join("\n")}`
        : response.content;
      orchestration.settleLeadTurnAttempt(attempt.id, "completed");
      const pendingHandoff = orchestration.actingAuthorityView();
      if (
        pendingHandoff?.state === "handoff-pending" &&
        pendingHandoff.handoff?.preparedForOwnerTurnId === turnId
      ) {
        orchestration.observeActingAuthorityHandoffDelivered(
          pendingHandoff.id,
          turnId,
          response.content,
        );
      }
      return content;
    } catch (error) {
      if (!(error instanceof PiTurnFailure)) throw error;
      orchestration.settleLeadTurnAttempt(attempt.id, "failed", error.kind);
      const decision = orchestration.modelFailureDecision(error);
      if (decision === "fallback") continue;
      if (decision === "revalidate") {
        const updatedValidation = await adapter.validateSelection(
          modelSelection,
          conversation.modelRequirements ?? defaultLeadModelRequirements,
        );
        if (orchestration.modelCandidateDecision(updatedValidation) === "skip") continue;
      }
      orchestration.observeLeadTurnFailure(turnId, `Lead Model turn failed: ${error.kind}.`);
      break;
    }
  }
  throw new HostDiagnostic(
    "CMD_RIKER_MODEL_UNAVAILABLE",
    "The configured Model did not complete the turn.",
  );
}

async function availableWorkerSupervisor(
  state: AuthoritativeState,
  configuration: OwnerConfiguration,
): Promise<WorkerSupervisor | undefined> {
  if (!configuration.workerModelPolicy) return undefined;
  const orchestration = createOrchestrationCore(state);
  const selection = configuration.workerModelPolicy.selection;
  try {
    let harness: NativeWorkerHarness;
    if (selection.nativeHarness === "codex") {
      harness = createCodexWorkerHarness(await resolveCodexRuntime());
    } else if (selection.nativeHarness === "claude") {
      harness = createClaudeWorkerHarness(await resolveClaudeRuntime());
    } else {
      harness = createCopilotWorkerHarness(await resolveCopilotRuntime());
    }
    if (
      selection.nativeHarness === "codex" &&
      orchestration.observeCodexCapabilityAvailable() === "cleared"
    ) {
      process.stderr.write(
        "CMD_RIKER_CODEX_AVAILABLE: Codex Worker capability is available again.\n",
      );
    }
    return createWorkerSupervisor(
      state,
      harness,
      createTargetProjectOperations(state),
    );
  } catch (error) {
    orchestration.reconcileInterruptedWorkers(
      `The ${nativeHarnessName(selection.nativeHarness)} capability could not be proven after host restart.`,
    );
    const detail = error instanceof Error ? error.message : "capability probe failed";
    const notice = selection.nativeHarness === "codex"
      ? orchestration.observeCodexCapabilityUnavailable(
          detail,
          configuration.targetProject.path,
        )
      : "recorded";
    if (notice === "recorded") {
      const code = `CMD_RIKER_${selection.nativeHarness.toUpperCase()}_UNAVAILABLE`;
      process.stderr.write(
        `${code}: ` +
          `${nativeHarnessName(selection.nativeHarness)} with expected native identity for Target Project ` +
          `${configuration.targetProject.path} is unavailable: ` +
          `${detail}\n`,
      );
    }
    return undefined;
  }
}

function nativeHarnessName(harness: "codex" | "claude" | "copilot"): string {
  return harness === "codex" ? "Codex" : harness === "claude" ? "Claude" : "Copilot";
}

function commitmentFingerprint(commitment: {
  state: string;
  condition?: { kind: string };
}): string {
  return `${commitment.state}:${commitment.condition?.kind ?? "none"}`;
}

function commitmentNotice(commitment: {
  id: string;
  outcome: string;
  state: string;
  condition?: { kind: string };
}): string {
  const status =
    commitment.state === "awaiting-acceptance"
      ? "awaiting Owner Acceptance"
      : commitment.condition?.kind ?? commitment.state;
  return `Commitment ${commitment.id} ${status}: ${commitment.outcome}`;
}

async function validatePolicy(
  adapter: PiTurnAdapter,
  configuration: OwnerConfiguration,
): Promise<void> {
  const policy = leadModelPolicy(configuration);
  const validations = [];
  for (const modelSelection of [policy.default, ...policy.fallbacks]) {
    validations.push(await adapter.validateSelection(modelSelection, policy.requirements));
  }
  assertValidatedLeadModelPolicy(policy, validations);
}

function leadModelPolicy(configuration: OwnerConfiguration): LeadModelPolicy {
  return {
    revision: configuration.modelPolicyRevision,
    default: configuration.modelSelection,
    fallbacks: configuration.modelFallbacks ?? [],
    requirements: configuration.modelRequirements ?? defaultLeadModelRequirements,
  };
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

class HostDiagnostic extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "input could not be read";
    throw new HostDiagnostic(
      "CMD_RIKER_STATE_RECOVERY_INPUT_INVALID",
      `Recovery input ${path} is not valid JSON: ${detail}`,
    );
  }
}

async function readConfiguration(stateDirectory: string): Promise<OwnerConfiguration> {
  return parseConfiguration(await readJsonFile(join(stateDirectory, "config.json")));
}

async function readStartupConfiguration(
  stateDirectory: string,
  required: boolean,
): Promise<OwnerConfiguration | undefined> {
  let configurationText: string;
  try {
    configurationText = await readFile(join(stateDirectory, "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!required) return undefined;
      throw new HostDiagnostic(
        "CMD_RIKER_CONFIG_MISSING",
        "Uninitialized state requires config.json in the state directory.",
      );
    }
    throw error;
  }
  try {
    return parseConfiguration(JSON.parse(configurationText) as unknown);
  } catch (error) {
    if (error instanceof HostDiagnostic) throw error;
    throw invalidConfiguration();
  }
}

function recoveryFailure(error: unknown): HostDiagnostic {
  if (error instanceof HostDiagnostic) return error;
  return new HostDiagnostic(
    "CMD_RIKER_STATE_RECOVERY_FAILED",
    error instanceof Error ? error.message : "Authoritative State recovery failed.",
  );
}

function invalidConfiguration(): HostDiagnostic {
  return new HostDiagnostic(
    "CMD_RIKER_CONFIG_INVALID",
    "config.json must contain a valid supported Owner configuration.",
  );
}

function parseConfiguration(value: unknown): OwnerConfiguration {
  const legacyKeys = ["targetProject", "modelSelection", "modelPolicyRevision"];
  const baseKeySets = [
    legacyKeys,
    [...legacyKeys, "modelFallbacks"],
    [...legacyKeys, "modelRequirements"],
    [...legacyKeys, "modelFallbacks", "modelRequirements"],
    [...legacyKeys, "workerModelPolicy"],
    [...legacyKeys, "modelFallbacks", "workerModelPolicy"],
    [...legacyKeys, "modelRequirements", "workerModelPolicy"],
    [...legacyKeys, "modelFallbacks", "modelRequirements", "workerModelPolicy"],
  ];
  const acceptedKeySets = baseKeySets.flatMap((keys) => [keys, [...keys, "forgeAuthorities"]]);
  if (!acceptedKeySets.some((keys) => isRecordWithKeys(value, keys))) {
    throw invalidConfiguration();
  }
  const configuration = value as Record<string, unknown>;
  const targetProject = configuration.targetProject;
  const modelSelection = configuration.modelSelection;
  if (
    !isRecordWithKeys(targetProject, ["path"]) ||
    typeof targetProject.path !== "string" ||
    !targetProject.path.trim() ||
    typeof configuration.modelPolicyRevision !== "string" ||
    !configuration.modelPolicyRevision.trim()
  ) {
    throw invalidConfiguration();
  }
  const selection = parseModelSelection(modelSelection);
  const fallbacks = configuration.modelFallbacks;
  if (fallbacks !== undefined && !Array.isArray(fallbacks)) throw invalidConfiguration();
  const parsedFallbacks = fallbacks?.map(parseModelSelection);
  const requirements = configuration.modelRequirements !== undefined
    ? parseModelRequirements(configuration.modelRequirements)
    : undefined;
  const workerModelPolicy = configuration.workerModelPolicy !== undefined
    ? parseWorkerModelPolicy(configuration.workerModelPolicy)
    : undefined;
  const forgeAuthorities = configuration.forgeAuthorities !== undefined
    ? parseForgeAuthorities(configuration.forgeAuthorities)
    : undefined;
  try {
    assertSupportedModelSelection(selection);
    for (const fallback of parsedFallbacks ?? []) assertSupportedModelSelection(fallback);
  } catch {
    throw invalidConfiguration();
  }
  return {
    targetProject: { path: targetProject.path },
    ...(forgeAuthorities ? { forgeAuthorities } : {}),
    modelSelection: selection,
    ...(parsedFallbacks ? { modelFallbacks: parsedFallbacks } : {}),
    ...(requirements ? { modelRequirements: requirements } : {}),
    modelPolicyRevision: configuration.modelPolicyRevision,
    ...(workerModelPolicy ? { workerModelPolicy } : {}),
  };
}

function parseForgeAuthorities(value: unknown): NonNullable<OwnerConfiguration["forgeAuthorities"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidConfiguration();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "github" && key !== "azure")) {
    throw invalidConfiguration();
  }
  const github = record.github;
  const azure = record.azure;
  if (github !== undefined && (
    !isRecordWithKeys(github, ["account", "repository"]) ||
    typeof github.account !== "string" ||
    typeof github.repository !== "string" ||
    !github.account.trim() ||
    !/^[^/\s]+\/[^/\s]+$/.test(github.repository)
  )) throw invalidConfiguration();
  if (azure !== undefined && (
    !isRecordWithKeys(azure, ["account", "subscriptionId"]) ||
    typeof azure.account !== "string" ||
    typeof azure.subscriptionId !== "string" ||
    !azure.account.trim() ||
    !/^[0-9a-f-]{36}$/i.test(azure.subscriptionId)
  )) throw invalidConfiguration();
  if (github === undefined && azure === undefined) throw invalidConfiguration();
  return {
    ...(github ? { github: { account: github.account as string, repository: github.repository as string } } : {}),
    ...(azure ? { azure: { account: azure.account as string, subscriptionId: azure.subscriptionId as string } } : {}),
  };
}

function parseWorkerModelPolicy(value: unknown): NonNullable<OwnerConfiguration["workerModelPolicy"]> {
  if (!isRecordWithKeys(value, ["revision", "selection"])) throw invalidConfiguration();
  if (
    typeof value.revision !== "string" ||
    !value.revision.trim() ||
    !isRecordWithKeys(value.selection, ["provider", "model", "nativeHarness"]) ||
    typeof value.selection.model !== "string"
  ) {
    throw invalidConfiguration();
  }
  const selection = value.selection.provider === "openai" && value.selection.nativeHarness === "codex"
    ? { provider: "openai" as const, model: value.selection.model, nativeHarness: "codex" as const }
    : value.selection.provider === "anthropic" && value.selection.nativeHarness === "claude"
      ? { provider: "anthropic" as const, model: value.selection.model, nativeHarness: "claude" as const }
      : value.selection.provider === "github" && value.selection.nativeHarness === "copilot"
        ? { provider: "github" as const, model: value.selection.model, nativeHarness: "copilot" as const }
        : undefined;
  if (!selection) throw invalidConfiguration();
  try {
    assertSupportedWorkerModelSelection(selection);
  } catch {
    throw invalidConfiguration();
  }
  return {
    revision: value.revision,
    selection,
  };
}

function parseModelRequirements(value: unknown): LeadModelRequirements {
  if (!isRecordWithKeys(value, [
    "requiredCapabilities",
    "minimumContextWindow",
    "dataHandling",
    "maximumInputCostPerMillionUsd",
  ])) {
    throw invalidConfiguration();
  }
  if (
    !Array.isArray(value.requiredCapabilities) ||
    value.requiredCapabilities.length === 0 ||
    !value.requiredCapabilities.every(
      (capability) => capability === "text" || capability === "image",
    ) ||
    typeof value.minimumContextWindow !== "number" ||
    !Number.isInteger(value.minimumContextWindow) ||
    value.minimumContextWindow < 1 ||
    (value.dataHandling !== "loopback-only" &&
      value.dataHandling !== "supported-integrations") ||
    (value.maximumInputCostPerMillionUsd !== null &&
      (typeof value.maximumInputCostPerMillionUsd !== "number" ||
        !Number.isFinite(value.maximumInputCostPerMillionUsd) ||
        value.maximumInputCostPerMillionUsd < 0))
  ) {
    throw invalidConfiguration();
  }
  return {
    requiredCapabilities: value.requiredCapabilities,
    minimumContextWindow: value.minimumContextWindow,
    dataHandling: value.dataHandling,
    maximumInputCostPerMillionUsd: value.maximumInputCostPerMillionUsd,
  };
}

function parseModelSelection(value: unknown): ModelSelection {
  if (!isRecordWithKeys(value, ["provider", "model", "api"])) {
    if (!isRecordWithKeys(value, ["provider", "model", "api", "baseUrl"])) {
      throw invalidConfiguration();
    }
    if (
      typeof value.provider !== "string" ||
      !value.provider.trim() ||
      typeof value.model !== "string" ||
      !value.model.trim() ||
      value.api !== "openai-completions" ||
      typeof value.baseUrl !== "string"
    ) {
      throw invalidConfiguration();
    }
    const selection: ModelSelection = {
      provider: value.provider,
      model: value.model,
      api: value.api,
      baseUrl: value.baseUrl,
    };
    try {
      assertSupportedModelSelection(selection);
    } catch {
      throw invalidConfiguration();
    }
    return selection;
  }
  if (
    value.provider !== "openai-codex" ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    value.api !== "openai-codex-responses"
  ) {
    throw invalidConfiguration();
  }
  return {
    provider: value.provider,
    model: value.model,
    api: value.api,
  };
}

function isRecordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

try {
  await main();
} catch (error) {
  if (error instanceof HostDiagnostic) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write("CMD_RIKER_HOST_FAILURE: The local host could not continue.\n");
  }
  process.exitCode = 2;
}
