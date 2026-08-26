import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  completeAuthoritativeStateRecovery,
  establishNewAuthoritativeStateBaseline,
  openAuthoritativeStateSafely,
  reconcilePostBackupEffect,
  restoreAuthoritativeStateBackup,
  StaleWriteGenerationError,
  type AuthoritativeState,
  type OwnerConfiguration,
  type PostBackupEffectInventory,
  type PostBackupEffectReconciliation,
} from "./authoritative-state/index.ts";
import {
  decodeHostedOwnerInput,
  encodeHostedOwnerConversation,
  encodeHostedOwnerError,
  encodeHostedOwnerProjects,
  encodeHostedOwnerResponse,
  encodeHostedOwnerSessionView,
  ownerTurnCompleteMarker,
  type HostedOwnerInput,
} from "./owner-host-framing.ts";
import {
  PiAgentTurnAdapter,
  type PiTurnAdapter,
} from "./conversation-runtime/index.ts";
import {
  assertSupportedModelSelection,
  leadThinkingLevels,
  type LeadThinkingLevel,
  type ModelSelection,
} from "./model-selection.ts";
import {
  assertSupportedWorkerModelSelection,
  assertValidatedLeadModelPolicy,
  createOrchestrationCore,
  defaultLeadModelRequirements,
  type LeadModelRequirements,
  type LeadModelPolicy,
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
import {
  commitmentNotice,
  createLeadAgentRuntime,
  LeadAgentRuntimeDiagnostic,
  type WorkerSupervisors,
} from "./lead-agent-runtime/index.ts";
import { runPiOwnerInterface } from "./pi-owner-interface.ts";
import {
  parseOwnerSessionControl,
  parseSessionViewControl,
  parseStandingOrderControl,
  projectSessionView,
  renderOwnerProjects,
  renderOwnerSessions,
  renderSessionItems,
  renderSessionView,
  renderSessionWorkers,
  renderStandingOrderDetail,
  renderStandingOrders,
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

  const writeGenerationArgument = argumentValue("--write-generation");
  const writeGeneration = writeGenerationArgument === undefined
    ? undefined
    : positiveIntegerArgument("--write-generation", writeGenerationArgument);
  const openedState = openAuthoritativeStateSafely(
    stateDirectory,
    writeGeneration === undefined ? {} : { writeGeneration },
  );
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
        state.initialize(configuration);
      } else {
        const {
          messages: _messages,
          forgeAuthorities: _durableForgeAuthorities,
          ...durableConfiguration
        } = conversation;
        state.initialize({
          ...durableConfiguration,
          ...(configuration.forgeAuthorities
            ? { forgeAuthorities: configuration.forgeAuthorities }
            : {}),
        });
        // A policy revision never seen durably is the Owner's way to swap the Lead
        // model via config.json: validate the new policy, then activate it durably.
        // A revision the durable record already knows is a stale file, not an order.
        if (
          configuration.modelPolicyRevision !== durableConfiguration.modelPolicyRevision &&
          !state.knownModelPolicyRevisions().includes(configuration.modelPolicyRevision)
        ) {
          await validatePolicy(adapter, configuration);
          policyValidated = true;
          state.replaceOwnerConfiguration({
            ...durableConfiguration,
            ...(configuration.forgeAuthorities
              ? { forgeAuthorities: configuration.forgeAuthorities }
              : {}),
            modelSelection: configuration.modelSelection,
            modelFallbacks: configuration.modelFallbacks ?? [],
            modelRequirements: configuration.modelRequirements ?? defaultLeadModelRequirements,
            modelPolicyRevision: configuration.modelPolicyRevision,
            ...(configuration.workerModelPolicy
              ? { workerModelPolicy: configuration.workerModelPolicy }
              : {}),
          });
        }
      }
      conversation = state.readOwnerConversation();
    }
    if (!conversation) throw new Error("Authoritative state could not be initialized.");
    createOrchestrationCore(state).reconcileInterruptedCommitments();
    if (!policyValidated) {
      await validatePolicy(adapter, conversation);
    }
    const ownerNotices: OwnerNoticeSink = {
      deliver: (content) =>
        process.stdout.write(`CMD_RIKER_WORKER_NOTICE: ${singleLine(content)}\n`),
    };
    const workerSupervisors = await availableWorkerSupervisors(state, conversation, ownerNotices);
    for (const supervisor of Object.values(workerSupervisors)) await supervisor.recover();
    // A restarted interface resumes the session the Owner spoke to last.
    const sessionContext: OwnerSessionContext = {
      activeSessionId: state.latestActiveOwnerSessionId(),
    };
    // A Worker notice implies changed session state; hosted clients keep their
    // structured Session View current from the same transcript stream.
    const deliverNotice = ownerNotices.deliver;
    ownerNotices.deliver = (content) => {
      deliverNotice(content);
      emitSessionData(state, workerSupervisors, sessionContext);
      if (process.argv.includes("--hosted")) {
        emitHostedProjectData(state, workerSupervisors);
      }
    };

    if (process.stdin.isTTY && process.stdout.isTTY) {
      await runInteractiveConversation(
        state,
        adapter,
        conversation.targetProject.path,
        workerSupervisors,
        ownerNotices,
        sessionContext,
      );
    } else {
      await runScriptableConversation(
        state,
        adapter,
        conversation.targetProject.path,
        workerSupervisors,
        sessionContext,
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
  workerSupervisors: WorkerSupervisors,
  sessionContext: OwnerSessionContext,
): Promise<void> {
  const hosted = process.argv.includes("--hosted");
  process.stdout.write(`CMD Riker | Target Project: ${targetProjectPath}\n`);
  process.stdout.write(`${currentSessionView(state, workerSupervisors, sessionContext)}\n`);
  emitSessionData(state, workerSupervisors, sessionContext);
  if (hosted) {
    emitHostedProjectData(state, workerSupervisors);
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const ownerInputLine of lines) {
    const framedInput = hosted ? hostedOwnerInput(ownerInputLine) : { content: ownerInputLine };
    const ownerInput = framedInput.content;
    if (!ownerInput.trim()) continue;
    let turnContext = sessionContext;
    if (framedInput.targetProjectPath) {
      try {
        turnContext = scopedSessionContext(state, {
          ...framedInput,
          targetProjectPath: framedInput.targetProjectPath,
        });
      } catch (error) {
        process.stdout.write("CMD_RIKER_OWNER_HANDLED\n");
        process.stdout.write(`${encodeHostedOwnerError(
          error instanceof Error ? error.message : "Invalid scoped Owner turn.",
        )}\n`);
        process.stdout.write(`${ownerTurnCompleteMarker}\n`);
        continue;
      }
    }
    let ownerTurnRecorded = false;
    const output = await completeOwnerInteraction(
      state,
      adapter,
      ownerInput,
      workerSupervisors,
      hosted
        ? (turnId) => {
            ownerTurnRecorded = true;
            process.stdout.write(`CMD_RIKER_OWNER_RECORDED:${turnId}\n`);
          }
        : undefined,
      turnContext,
    );
    if (hosted && !ownerTurnRecorded) {
      process.stdout.write("CMD_RIKER_OWNER_HANDLED\n");
    }
    process.stdout.write(hosted
      ? `${encodeHostedOwnerResponse(output)}\n`
      : `${output.source}: ${output.content}\n`);
    process.stdout.write(`${currentSessionView(state, workerSupervisors, turnContext)}\n`);
    emitSessionData(state, workerSupervisors, turnContext);
    if (hosted) {
      emitHostedProjectData(state, workerSupervisors);
      if (turnContext.targetProjectPath) {
        emitHostedProjectProjection(state, workerSupervisors, turnContext.targetProjectPath, turnContext);
      }
      process.stdout.write(`${ownerTurnCompleteMarker}\n`);
    }
  }
}

function hostedOwnerInput(line: string): HostedOwnerInput {
  // Invalid framing remains ordinary Owner input rather than becoming a host command.
  return decodeHostedOwnerInput(line) ?? { content: line };
}

function emitSessionData(
  state: AuthoritativeState,
  workerSupervisors: WorkerSupervisors,
  sessionContext?: OwnerSessionContext,
): void {
  process.stdout.write(
    `CMD_RIKER_SESSION_JSON:${JSON.stringify(sessionViewSnapshot(state, workerSupervisors, "available", sessionContext))}\n`,
  );
}

function emitConversationData(
  state: AuthoritativeState,
  sessionContext: OwnerSessionContext,
): void {
  const session = sessionContext.activeSessionId
    ? state.readOwnerSessions().find((entry) => entry.id === sessionContext.activeSessionId)
    : undefined;
  const projectPath = sessionContext.targetProjectPath ??
    sessionProjectPath(state, session?.projectPath);
  const conversation = sessionContext.activeSessionId
    ? state.readOwnerConversation(sessionContext.activeSessionId)
    : undefined;
  if (!sessionContext.activeSessionId || (!session && conversation?.messages.length === 0)) {
    process.stdout.write(`${encodeHostedOwnerConversation({
      targetProjectPath: projectPath,
      entries: [],
    })}\n`);
    return;
  }
  process.stdout.write(`${encodeHostedOwnerConversation({
    sessionId: sessionContext.activeSessionId,
    targetProjectPath: projectPath,
    entries: (conversation?.messages ?? []).map((message) => ({
      source: message.role,
      content: message.content,
    })),
  })}\n`);
}

function emitHostedProjectData(
  state: AuthoritativeState,
  workerSupervisors: WorkerSupervisors,
): void {
  const projects = state.readConfiguredProjects();
  const projections = projects.map((project) => ({
    project,
    session: latestProjectSession(state, project.path),
  }));
  process.stdout.write(`${encodeHostedOwnerProjects(projections.map(({ project, session }) => ({
    targetProjectPath: project.path,
    ...(session ? { sessionId: session.id } : {}),
  })))}\n`);
  for (const { project, session } of projections) {
    emitHostedProjectProjection(state, workerSupervisors, project.path, {
      ...(session ? { activeSessionId: session.id } : {}),
      targetProjectPath: project.path,
    });
  }
}

function emitHostedProjectProjection(
  state: AuthoritativeState,
  workerSupervisors: WorkerSupervisors,
  targetProjectPath: string,
  sessionContext: OwnerSessionContext,
): void {
  process.stdout.write(`${encodeHostedOwnerSessionView({
    targetProjectPath,
    ...(sessionContext.activeSessionId ? { sessionId: sessionContext.activeSessionId } : {}),
    snapshot: sessionViewSnapshot(state, workerSupervisors, "available", sessionContext),
  })}\n`);
  emitConversationData(state, sessionContext);
}

async function runInteractiveConversation(
  state: AuthoritativeState,
  adapter: PiTurnAdapter,
  targetProjectPath: string,
  workerSupervisors: WorkerSupervisors,
  ownerNotices: OwnerNoticeSink,
  sessionContext: OwnerSessionContext,
): Promise<void> {
  let attachment = currentOwnerAttachment(state, sessionContext, targetProjectPath);
  while (true) {
    const outcome = await runPiOwnerInterface({
      ...attachment,
      completeOwnerInput: (ownerInput) =>
        completeOwnerInteraction(
          state,
          adapter,
          ownerInput,
          workerSupervisors,
          undefined,
          sessionContext,
        ),
      readSessionView: () => currentSessionView(state, workerSupervisors, sessionContext),
      readSessionData: () => sessionViewSnapshot(state, workerSupervisors, "available", sessionContext),
      subscribeNotices: (listener) => {
        const previous = ownerNotices.deliver;
        ownerNotices.deliver = listener;
        return () => {
          ownerNotices.deliver = previous;
        };
      },
    });
    if (outcome !== "conversation-replaced") return;
    attachment = currentOwnerAttachment(state, sessionContext, targetProjectPath);
  }
}

type OwnerInteractionOutput = {
  source: "Lead Agent" | "Session View";
  content: string;
  reattach?: true;
};

/** Which Owner Session one presentation client is serving; switching mutates only this cursor. */
type OwnerSessionContext = { activeSessionId?: string; targetProjectPath?: string };

async function completeOwnerInteraction(
  state: AuthoritativeState,
  adapter: PiTurnAdapter,
  ownerInput: string,
  workerSupervisors: WorkerSupervisors = {},
  onOwnerTurnRecorded?: (turnId: string) => void,
  sessionContext?: OwnerSessionContext,
): Promise<OwnerInteractionOutput> {
  if (!/^\/session\s+/i.test(ownerInput)) {
    if (sessionContext?.targetProjectPath && !sessionContext.activeSessionId) {
      sessionContext.activeSessionId = randomUUID();
      state.appendOwnerSessionSnapshots([{
        id: sessionContext.activeSessionId,
        name: "",
        createdAt: new Date().toISOString(),
        projectPath: sessionContext.targetProjectPath,
        state: "active",
      }]);
    }
    return {
      source: "Lead Agent",
      content: await createLeadAgentRuntime({
        state,
        adapter,
        workerSupervisors,
      })
        .completeOwnerTurn(ownerInput, onOwnerTurnRecorded, sessionContext?.activeSessionId),
    };
  }
  const snapshot = sessionViewSnapshot(state, workerSupervisors, "available", sessionContext);
  const sessionAction = parseOwnerSessionControl(snapshot.sessions ?? [], ownerInput);
  if (sessionAction?.kind === "list-sessions") {
    return {
      source: "Session View",
      content: renderOwnerSessions(snapshot.sessions ?? []),
    };
  }
  if (sessionAction?.kind === "list-projects") {
    return {
      source: "Session View",
      content: renderOwnerProjects(snapshot.projects ?? []),
    };
  }
  if (sessionAction?.kind === "new-session" && sessionContext) {
    let projectPath = sessionContext.targetProjectPath;
    if (sessionAction.project) {
      const projects = snapshot.projects ?? [];
      const requested = sessionAction.project.toLowerCase();
      const match = projects.find(
        (candidate) =>
          candidate.name.toLowerCase() === requested || String(candidate.number) === requested,
      );
      if (!match) {
        return {
          source: "Session View",
          content: `Unknown project "${sessionAction.project}". /session projects lists them.`,
        };
      }
      if (sessionContext.targetProjectPath && !samePath(match.path, sessionContext.targetProjectPath)) {
        return {
          source: "Session View",
          content: "This gateway can start sessions only in its bound project.",
        };
      }
      projectPath = match.path;
    }
    const sessionId = randomUUID();
    state.appendOwnerSessionSnapshots([
      {
        id: sessionId,
        name: "",
        createdAt: new Date().toISOString(),
        ...(projectPath ? { projectPath } : {}),
        state: "active",
      },
    ]);
    sessionContext.activeSessionId = sessionId;
    return {
      source: "Lead Agent",
      content: "New session started. Its first prompt names it.",
      reattach: true,
    };
  }
  if (sessionAction?.kind === "use-session" && sessionContext) {
    sessionContext.activeSessionId = sessionAction.sessionId;
    return {
      source: "Lead Agent",
      content: `Switched to session "${sessionAction.name || "(unnamed)"}". New turns continue there.`,
      reattach: true,
    };
  }
  if (/^\/session\s+items\s*$/i.test(ownerInput)) {
    return {
      source: "Session View",
      content: renderSessionItems(snapshot),
    };
  }
  if (/^\/session\s+workers\s*$/i.test(ownerInput)) {
    return {
      source: "Session View",
      content: renderSessionWorkers(snapshot),
    };
  }
  if (/^\/session\s+orders\s*$/i.test(ownerInput)) {
    return {
      source: "Session View",
      content: renderStandingOrders(snapshot.standingOrders ?? []),
    };
  }
  const orderAction = parseStandingOrderControl(snapshot.standingOrders ?? [], ownerInput);
  if (orderAction?.kind === "show-order") {
    return {
      source: "Session View",
      content: renderStandingOrderDetail(orderAction.entry),
    };
  }
  if (orderAction?.kind === "revoke-order") {
    const ownerTurnId = state.appendOwnerMessage(ownerInput, sessionContext?.activeSessionId);
    onOwnerTurnRecorded?.(ownerTurnId);
    createOrchestrationCore(state).revokeStandingOrder(
      orderAction.standingOrderId,
      ownerTurnId,
      orderAction.reason,
    );
    state.recordOwnerInteractionDisposition(ownerTurnId, "owner-control");
    return {
      source: "Lead Agent",
      content: "Standing Order revoked. Effects already dispatched under it are not rolled back.",
    };
  }
  const action = parseSessionViewControl(snapshot, ownerInput);
  if (!action) {
    return {
      source: "Session View",
      content: "That control is not available right now.",
    };
  }
  const ownerTurnId = state.appendOwnerMessage(ownerInput, sessionContext?.activeSessionId);
  onOwnerTurnRecorded?.(ownerTurnId);
  const supervisor = supervisorOfWorker(state, workerSupervisors, action.workerSessionId);
  if (!supervisor) throw new Error("Session View exposed cancellation without a live Worker supervisor.");
  await supervisor.cancel(
    action.workerSessionId,
    ownerTurnId,
    "Owner requested cancellation through the Owner conversation.",
  );
  state.recordOwnerInteractionDisposition(ownerTurnId, "owner-control");
  return {
    source: "Lead Agent",
    content: "Cancellation requested. Changes already made are not rolled back.",
  };
}

function currentOwnerAttachment(
  state: AuthoritativeState,
  sessionContext: OwnerSessionContext,
  fallbackTargetProjectPath: string,
) {
  const session = state.readOwnerSessions().find(
    (candidate) => candidate.id === sessionContext.activeSessionId,
  );
  const configuredProjects = state.readConfiguredProjects();
  const targetProjectPath = session?.projectPath
    ? configuredProjects.find(
        (project) => project.path.toLowerCase() === session.projectPath!.toLowerCase(),
      )?.path ?? configuredProjects[0]?.path ?? fallbackTargetProjectPath
    : configuredProjects[0]?.path ?? fallbackTargetProjectPath;
  const conversation = state.readOwnerConversation(sessionContext.activeSessionId);
  return {
    targetProjectPath,
    transcript: [
      ...(conversation?.messages ?? []).map((message) => ({
        source: message.role,
        content: message.content,
      })),
      ...state.readCommitments().map((commitment) => ({
        source: "lead-agent" as const,
        content: commitmentNotice(commitment),
      })),
    ],
  };
}

function currentSessionView(
  state: AuthoritativeState,
  workerSupervisors: WorkerSupervisors = {},
  sessionContext?: OwnerSessionContext,
  leadAvailability: SessionViewSnapshot["leadAvailability"] = "available",
): string {
  return renderSessionView(
    sessionViewSnapshot(state, workerSupervisors, leadAvailability, sessionContext),
  );
}

function sessionViewSnapshot(
  state: AuthoritativeState,
  workerSupervisors: WorkerSupervisors = {},
  leadAvailability: SessionViewSnapshot["leadAvailability"] = "available",
  sessionContext?: OwnerSessionContext,
): SessionViewSnapshot {
  return projectSessionView(state, {
    leadAvailability,
    cancellationAvailable: Object.keys(workerSupervisors).length > 0,
    ...(sessionContext?.activeSessionId
      ? { activeSessionId: sessionContext.activeSessionId }
      : {}),
    ...(sessionContext?.targetProjectPath
      ? { targetProjectPath: sessionContext.targetProjectPath }
      : {}),
  });
}

function scopedSessionContext(
  state: AuthoritativeState,
  input: HostedOwnerInput & { targetProjectPath: string },
): OwnerSessionContext {
  const targetProjectPath = configuredProjectPath(state, input.targetProjectPath);
  if (!targetProjectPath) {
    throw new Error(`Unknown configured project path "${input.targetProjectPath}".`);
  }
  if (input.sessionId) {
    const session = state.readOwnerSessions().find((candidate) => candidate.id === input.sessionId);
    if (!session || !samePath(sessionProjectPath(state, session.projectPath), targetProjectPath)) {
      throw new Error("The selected Owner Session does not belong to the gateway project.");
    }
    return { activeSessionId: session.id, targetProjectPath };
  }
  const latest = latestProjectSession(state, targetProjectPath);
  return {
    ...(latest ? { activeSessionId: latest.id } : {}),
    targetProjectPath,
  };
}

function latestProjectSession(state: AuthoritativeState, targetProjectPath: string) {
  return state.readOwnerSessions().find((session) =>
    session.state === "active" &&
    samePath(sessionProjectPath(state, session.projectPath), targetProjectPath)
  );
}

function sessionProjectPath(state: AuthoritativeState, projectPath: string | undefined): string {
  return projectPath ?? state.readConfiguredProjects()[0]!.path;
}

function configuredProjectPath(state: AuthoritativeState, requestedPath: string): string | undefined {
  return state.readConfiguredProjects().find((project) => samePath(project.path, requestedPath))?.path;
}

function samePath(left: string, right: string): boolean {
  return left.replaceAll("/", "\\").toLowerCase() ===
    right.replaceAll("/", "\\").toLowerCase();
}

function supervisorOfWorker(
  state: AuthoritativeState,
  workerSupervisors: WorkerSupervisors,
  workerSessionId: string,
): WorkerSupervisor | undefined {
  const worker = state.readWorkerSession(workerSessionId);
  const attempt = worker
    ? state.readWorkerExecutionAttempt(worker.currentExecutionAttemptId)
    : undefined;
  return attempt ? workerSupervisors[attempt.modelSelection.nativeHarness] : undefined;
}

type OwnerNoticeSink = { deliver: (content: string) => void };

function singleLine(content: string): string {
  return content.replaceAll(/\s*\r?\n\s*/g, " | ").trim();
}

async function availableWorkerSupervisors(
  state: AuthoritativeState,
  configuration: OwnerConfiguration,
  ownerNotices: OwnerNoticeSink,
): Promise<WorkerSupervisors> {
  const settings = configuration.workerHarnessSettings ?? {};
  const configured = configuration.workerModelPolicy?.selection.nativeHarness;
  const candidates: Array<"codex" | "claude" | "copilot"> = [];
  if (configured && settings[configured]?.enabled !== false) candidates.push(configured);
  for (const harnessName of ["codex", "claude", "copilot"] as const) {
    const setting = settings[harnessName];
    if (harnessName !== configured && setting?.enabled === true && setting.model) {
      candidates.push(harnessName);
    }
  }
  const orchestration = createOrchestrationCore(state);
  const operations = createTargetProjectOperations(state);
  const supervisors: WorkerSupervisors = {};
  const failures: Array<{ harness: "codex" | "claude" | "copilot"; detail: string }> = [];
  for (const harnessName of candidates) {
    try {
      let harness: NativeWorkerHarness;
      if (harnessName === "codex") {
        harness = createCodexWorkerHarness(await resolveCodexRuntime());
      } else if (harnessName === "claude") {
        harness = createClaudeWorkerHarness(await resolveClaudeRuntime());
      } else {
        harness = createCopilotWorkerHarness(await resolveCopilotRuntime());
      }
      if (
        harnessName === "codex" &&
        orchestration.observeCodexCapabilityAvailable() === "cleared"
      ) {
        process.stderr.write(
          "CMD_RIKER_CODEX_AVAILABLE: Codex Worker capability is available again.\n",
        );
      }
      supervisors[harnessName] = createWorkerSupervisor(
        state,
        harness,
        operations,
        undefined,
        (notice) => ownerNotices.deliver(notice),
      );
    } catch (error) {
      failures.push({
        harness: harnessName,
        detail: error instanceof Error ? error.message : "capability probe failed",
      });
    }
  }
  if (Object.keys(supervisors).length === 0 && failures.length > 0) {
    const failed = failures[0]!;
    orchestration.reconcileInterruptedWorkers(
      `The ${nativeHarnessName(failed.harness)} capability could not be proven after host restart.`,
    );
  }
  for (const failed of failures) {
    const notice = failed.harness === "codex"
      ? orchestration.observeCodexCapabilityUnavailable(
          failed.detail,
          configuration.targetProject.path,
        )
      : "recorded";
    if (notice === "recorded") {
      const code = `CMD_RIKER_${failed.harness.toUpperCase()}_UNAVAILABLE`;
      process.stderr.write(
        `${code}: ` +
          `${nativeHarnessName(failed.harness)} with expected native identity for Target Project ` +
          `${configuration.targetProject.path} is unavailable: ` +
          `${failed.detail}\n`,
      );
    }
  }
  return supervisors;
}

function nativeHarnessName(harness: "codex" | "claude" | "copilot"): string {
  return harness === "codex" ? "Codex" : harness === "claude" ? "Claude" : "Copilot";
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

function positiveIntegerArgument(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new HostDiagnostic("CMD_RIKER_ARGUMENT_INVALID", `${name} must be a positive integer.`);
  }
  return parsed;
}

function requiredArgument(name: string): string {
  const value = argumentValue(name);
  if (!value) {
    throw new HostDiagnostic("CMD_RIKER_ARGUMENT_INVALID", `${name} is required.`);
  }
  return value;
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
  const acceptedKeySets = baseKeySets
    .flatMap((keys) => [keys, [...keys, "projects"]])
    .flatMap((keys) => [keys, [...keys, "forgeAuthorities"]]);
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
  const projects = configuration.projects !== undefined
    ? parseProjects(configuration.projects)
    : undefined;
  try {
    assertSupportedModelSelection(selection);
    for (const fallback of parsedFallbacks ?? []) assertSupportedModelSelection(fallback);
  } catch {
    throw invalidConfiguration();
  }
  return {
    targetProject: { path: targetProject.path },
    ...(projects ? { projects } : {}),
    ...(forgeAuthorities ? { forgeAuthorities } : {}),
    modelSelection: selection,
    ...(parsedFallbacks ? { modelFallbacks: parsedFallbacks } : {}),
    ...(requirements ? { modelRequirements: requirements } : {}),
    modelPolicyRevision: configuration.modelPolicyRevision,
    ...(workerModelPolicy ? { workerModelPolicy } : {}),
  };
}

function parseProjects(value: unknown): NonNullable<OwnerConfiguration["projects"]> {
  if (!Array.isArray(value) || value.length === 0) throw invalidConfiguration();
  return value.map((entry) => {
    if (
      !isRecordWithKeys(entry, ["name", "path"]) ||
      typeof entry.name !== "string" ||
      typeof entry.path !== "string" ||
      !entry.name.trim() ||
      !entry.path.trim()
    ) {
      throw invalidConfiguration();
    }
    return { name: entry.name, path: entry.path };
  });
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
  if (
    !isRecordWithKeys(value, ["provider", "model", "api"]) &&
    !isRecordWithKeys(value, ["provider", "model", "api", "thinkingLevel"])
  ) {
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
  const thinkingLevel = value.thinkingLevel;
  if (
    thinkingLevel !== undefined &&
    !leadThinkingLevels.includes(thinkingLevel as LeadThinkingLevel)
  ) {
    throw invalidConfiguration();
  }
  return {
    provider: value.provider,
    model: value.model,
    api: value.api,
    ...(thinkingLevel !== undefined
      ? { thinkingLevel: thinkingLevel as LeadThinkingLevel }
      : {}),
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
  if (error instanceof HostDiagnostic || error instanceof LeadAgentRuntimeDiagnostic) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else if (error instanceof StaleWriteGenerationError) {
    const activeGeneration = /active generation is (\d+)/.exec(error.message)?.[1] ?? "unknown";
    process.stderr.write(
      `CMD_RIKER_STALE_GENERATION: This Lead Agent process is fenced from Authoritative State generation ${activeGeneration}.\n`,
    );
  } else {
    process.stderr.write("CMD_RIKER_HOST_FAILURE: The local host could not continue.\n");
  }
  process.exitCode = 2;
}
