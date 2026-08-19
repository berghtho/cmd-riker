import {
  createOrchestrationCore,
  type OrchestrationState,
  type WorkerExecutionAttempt,
  type WorkerModelSelection,
  type WorkerNativeHarnessSelection,
  type WorkerNativeCapabilities,
  type WorkerReportedOutcome,
  type WorkerSession,
} from "../orchestration-core/index.ts";
import type { TargetProjectOperations } from "../target-project-operations/index.ts";
import {
  NativeEffectfulCheckoutInspector,
  type EffectfulCheckoutInspector,
} from "./checkout-isolation.ts";

export {
  createCodexWorkerHarness,
  proveCodexWorkspaceWriteIsolation,
  resolveCodexRuntime,
  type CodexRuntime,
} from "./codex-app-server.ts";
export {
  createClaudeWorkerHarness,
  resolveClaudeRuntime,
  type ClaudeRuntime,
} from "./claude-process.ts";
export {
  createCopilotWorkerHarness,
  resolveCopilotRuntime,
  type CopilotRuntime,
} from "./copilot-acp.ts";
export {
  NativeEffectfulCheckoutInspector,
  type EffectfulCheckoutInspector,
  type IsolatedCheckout,
} from "./checkout-isolation.ts";

type WorkerStartRequestBase = {
  workerSessionId: string;
  executionAttemptId: string;
  objective: string;
  prompt: string;
  targetProjectPath: string;
  model: string;
  priorAnswers?: Array<{
    questionId: string;
    questions: Array<{ id: string; question: string }>;
    answers: Record<string, string[]>;
  }>;
};

export type WorkerStartRequest =
  | (WorkerStartRequestBase & { readOnly: true })
  | (WorkerStartRequestBase & {
      readOnly: false;
      targets: string[];
      authorizedWriteRoot: string;
      timeoutMs: number;
      recoveryConstraint: "reconcile-before-replay";
    });

export type WorkerExecutionObserver = {
  processStarted(identity: {
    process: { pid: number; startedAt: string };
    harnessVersion: string;
    protocolSchemaSha256: string;
  }): void;
  question(request: {
    providerRequestId: number | string;
    itemId: string;
    questions: Array<{
      id: string;
      question: string;
      options?: Array<{ label: string; description?: string }>;
      isOther: boolean;
    }>;
  }): void;
  output(text: string): void;
  materialCommand?(command: string): void;
  effectDispatchStarted?(): void | Promise<void>;
  completed(
    status: "completed" | "failed" | "interrupted",
    detail?: string,
    reportedOutcome?: WorkerReportedOutcome,
  ): void | Promise<void>;
  failed(error: Error): void | Promise<void>;
};

export type NativeWorkerExecution = {
  identity: {
    providerSessionId: string;
    nativeExecutionId: string;
    process: { pid: number; startedAt: string };
    harnessVersion: string;
    protocolSchemaSha256: string;
    capabilities: WorkerNativeCapabilities;
    writeIsolation?: "codex-windows-workspace-write";
  };
  answer(providerRequestId: number | string, answers: Record<string, string[]>): Promise<void>;
  interrupt(): Promise<void>;
  terminate(): Promise<{ gone: boolean }>;
};

export interface NativeWorkerHarness {
  readonly selection: WorkerNativeHarnessSelection;
  readonly supportsEffectful: boolean;
  start(
    request: WorkerStartRequest,
    observer: WorkerExecutionObserver,
  ): Promise<NativeWorkerExecution>;
  abandon(process: { pid: number; startedAt: string }): Promise<{ gone: boolean }>;
}

export type CodexWorkerExecution = NativeWorkerExecution;
export interface CodexWorkerHarness extends NativeWorkerHarness {}

export interface WorkerSupervisor {
  capabilities(): {
    nativeHarness: WorkerModelSelection["nativeHarness"];
    effectful: boolean;
    nativeQuestions: boolean;
    cancellation: boolean;
  };
  delegate(input: {
    objective: string;
    prompt: string;
    targetProjectPath: string;
    model: string;
    modelPolicyRevision: string;
    commitmentId?: string;
    recoveryOfWorkerSessionId?: string;
    recoveryReason?: string;
  }): Promise<{ workerSessionId: string; executionAttemptId: string }>;
  delegateEffectful(input: {
    objective: string;
    prompt: string;
    targetProjectPath: string;
    model: string;
    modelPolicyRevision: string;
    commitmentId: string;
    targets: string[];
    timeoutMs: number;
    verification: { operation: "test"; workingDirectory: string; timeoutMs: number };
    actingAuthorityEffectAuthorizationId?: string;
  }): Promise<{ workerSessionId: string; executionAttemptId: string }>;
  delegateReview(input: {
    implementationWorkerSessionId: string;
    prompt: string;
    model: string;
    modelPolicyRevision: string;
  }): Promise<{ workerSessionId: string; executionAttemptId: string }>;
  answer(
    questionId: string,
    ownerTurnId: string,
    answers: Record<string, string[]>,
  ): Promise<void>;
  cancel(workerSessionId: string, ownerTurnId: string, reason: string): Promise<void>;
  recover(): Promise<void>;
}

export function createWorkerSupervisor(
  state: OrchestrationState,
  harness: NativeWorkerHarness,
  verificationOperations?: TargetProjectOperations,
  checkoutInspector: EffectfulCheckoutInspector = new NativeEffectfulCheckoutInspector(),
): WorkerSupervisor {
  const orchestration = createOrchestrationCore(state);
  const executions = new Map<string, NativeWorkerExecution>();
  const outputByAttempt = new Map<string, string>();
  const commandsByAttempt = new Map<string, string[]>();
  const deadlinesByAttempt = new Map<string, NodeJS.Timeout[]>();
  const clearDeadlines = (executionAttemptId: string): void => {
    for (const timer of deadlinesByAttempt.get(executionAttemptId) ?? []) clearTimeout(timer);
    deadlinesByAttempt.delete(executionAttemptId);
  };
  const verifySettledWorker = async (
    workerSession: WorkerSession,
    executionAttempt: WorkerExecutionAttempt,
  ): Promise<void> => {
    if (workerSession.assignment.readOnly || !verificationOperations) {
      throw new Error("Effectful Worker Verification operations are unavailable.");
    }
    const existingAttempt = state.readTargetProjectOperationAttempts().find(
      (attempt) =>
        attempt.causedByWorker?.workerSessionId === workerSession.id &&
        attempt.causedByWorker.executionAttemptId === executionAttempt.id &&
        attempt.causedByWorker.generation === executionAttempt.generation,
    );
    if (existingAttempt) {
      if (existingAttempt.result) {
        orchestration.observeWorkerVerificationResult(
          workerSession.id,
          executionAttempt.id,
          existingAttempt.result,
        );
      }
      return;
    }
    const result = await verificationOperations.execute(
      orchestration.workerVerificationRequest(workerSession.id, executionAttempt.id),
    );
    orchestration.observeWorkerVerificationResult(workerSession.id, executionAttempt.id, result);
  };
  const startExecution = async (
    workerSession: WorkerSession,
    executionAttempt: WorkerExecutionAttempt,
  ): Promise<void> => {
    if (!sameNativeHarness(executionAttempt.modelSelection, harness.selection)) {
      throw new Error(
        `${nativeHarnessName(executionAttempt.modelSelection.nativeHarness)} continuity is unavailable because the configured Native Harness changed.`,
      );
    }
    orchestration.claimWorkerLaunch(workerSession.id, executionAttempt.id);
    const ready = Promise.withResolvers<NativeWorkerExecution>();
    void ready.promise.catch(() => {});
    const retainedAnswers = orchestration
      .workerQuestionsView()
      .filter(
        (question) =>
          question.workerSessionId === workerSession.id &&
          (question.status === "answer-recorded" || question.status === "delivered") &&
          question.deliveredExecutionAttemptId !== executionAttempt.id &&
          question.answer,
      )
      .map((question) => ({
        questionId: question.id,
        questions: question.questions.map(({ id, question: text }) => ({ id, question: text })),
        answers: question.answer!.answers,
      }));
    try {
      const requestBase = {
          workerSessionId: workerSession.id,
          executionAttemptId: executionAttempt.id,
          objective: workerSession.assignment.objective,
          prompt: workerSession.assignment.prompt,
          targetProjectPath: workerSession.assignment.targetProjectPath,
          model: executionAttempt.modelSelection.model,
          ...(retainedAnswers.length ? { priorAnswers: retainedAnswers } : {}),
        };
      const request: WorkerStartRequest = workerSession.assignment.readOnly
        ? { ...requestBase, readOnly: true }
        : {
            ...requestBase,
            readOnly: false,
            targets: workerSession.assignment.targets,
            authorizedWriteRoot: workerSession.assignment.authorizedWriteRoots[0],
            timeoutMs: workerSession.assignment.timeoutMs,
            recoveryConstraint: workerSession.assignment.recoveryConstraint,
          };
      const execution = await harness.start(
        request,
        {
          processStarted(identity) {
            orchestration.observeWorkerProcessStarted({
              workerSessionId: workerSession.id,
              executionAttemptId: executionAttempt.id,
              ...identity,
            });
          },
          question(request) {
            orchestration.observeWorkerQuestion({
              workerSessionId: workerSession.id,
              executionAttemptId: executionAttempt.id,
              ...request,
            });
          },
          output(text) {
            const existing = outputByAttempt.get(executionAttempt.id) ?? "";
            outputByAttempt.set(executionAttempt.id, `${existing}${text}`.slice(-64 * 1024));
          },
          materialCommand(command) {
            const commands = commandsByAttempt.get(executionAttempt.id) ?? [];
            commandsByAttempt.set(executionAttempt.id, [...commands, command].slice(-100));
          },
          effectDispatchStarted() {
            orchestration.claimWorkerEffectDispatch(workerSession.id, executionAttempt.id);
          },
          async completed(status, detail, reportedOutcome) {
            clearDeadlines(executionAttempt.id);
            const liveExecution = await ready.promise;
            const termination = await liveExecution.terminate();
            let observedChanges: string[] | undefined;
            let observationFailure: string | undefined;
            if (!workerSession.assignment.readOnly && status === "completed") {
              try {
                observedChanges = await checkoutInspector.observeChanges(
                  workerSession.assignment.checkoutIsolation,
                  workerSession.assignment.timeoutMs,
                );
              } catch (error) {
                observationFailure = error instanceof Error
                  ? error.message
                  : "The isolated checkout change could not be observed.";
              }
            }
            const terminalDetail = observationFailure ?? detail;
            const terminal = orchestration.observeWorkerTerminal({
              workerSessionId: workerSession.id,
              executionAttemptId: executionAttempt.id,
              status,
              processGone: termination.gone,
              ...(outputByAttempt.get(executionAttempt.id)
                ? { output: outputByAttempt.get(executionAttempt.id)! }
                : {}),
              ...(terminalDetail ? { detail: terminalDetail } : {}),
              ...(commandsByAttempt.get(executionAttempt.id)
                ? { materialCommands: commandsByAttempt.get(executionAttempt.id)! }
                : {}),
              ...(reportedOutcome ? { reportedOutcome } : {}),
              ...(observedChanges ? { observedChanges } : {}),
            });
            if (executions.get(workerSession.id) === liveExecution) {
              executions.delete(workerSession.id);
            }
            outputByAttempt.delete(executionAttempt.id);
            commandsByAttempt.delete(executionAttempt.id);
            if (terminal === "settled" && !workerSession.assignment.readOnly) {
              const effect = executionAttempt.effectIntentId
                ? state.readEffectIntent(executionAttempt.effectIntentId)
                : undefined;
              if (effect?.status === "succeeded") {
                await verifySettledWorker(workerSession, executionAttempt);
              }
            }
          },
          async failed(error) {
            clearDeadlines(executionAttempt.id);
            let liveExecution: NativeWorkerExecution;
            try {
              liveExecution = await ready.promise;
            } catch {
              return;
            }
            const termination = await liveExecution.terminate();
            orchestration.recordWorkerContinuityLoss(
              workerSession.id,
              executionAttempt.id,
              error.message,
            );
            const recovery = orchestration.recoverWorker(
              workerSession.id,
              termination.gone,
            );
            if (executions.get(workerSession.id) === liveExecution) {
              executions.delete(workerSession.id);
            }
            outputByAttempt.delete(executionAttempt.id);
            commandsByAttempt.delete(executionAttempt.id);
            if (recovery.kind === "restart") {
              await startExecution(recovery.workerSession, recovery.executionAttempt);
            }
          },
        },
      );
      orchestration.observeWorkerAttemptStarted({
        workerSessionId: workerSession.id,
        executionAttemptId: executionAttempt.id,
        providerSessionId: execution.identity.providerSessionId,
        nativeExecutionId: execution.identity.nativeExecutionId,
        process: execution.identity.process,
        harnessVersion: execution.identity.harnessVersion,
        capabilities: execution.identity.capabilities,
        ...(execution.identity.writeIsolation
          ? { writeIsolation: "authorized-write-root-enforced" as const }
          : {}),
      });
      executions.set(workerSession.id, execution);
      ready.resolve(execution);
      if (!workerSession.assignment.readOnly) {
        const deadline = setTimeout(() => {
          orchestration.requestWorkerDeadlineExceeded(workerSession.id);
          void execution.interrupt().catch(async (error: unknown) => {
            const termination = await execution.terminate();
            if (!termination.gone) return;
            orchestration.observeWorkerTerminal({
              workerSessionId: workerSession.id,
              executionAttemptId: executionAttempt.id,
              status: "interrupted",
              processGone: true,
              detail: error instanceof Error ? error.message : "Worker deadline interruption failed.",
            });
            executions.delete(workerSession.id);
            clearDeadlines(executionAttempt.id);
          });
          const escalation = setTimeout(async () => {
            const current = orchestration.workerExecutionAttemptView(executionAttempt.id);
            if (!current || current.status !== "running") return;
            const termination = await execution.terminate();
            if (!termination.gone) return;
            orchestration.observeWorkerTerminal({
              workerSessionId: workerSession.id,
              executionAttemptId: executionAttempt.id,
              status: "interrupted",
              processGone: true,
              detail: "Worker deadline interruption required process termination.",
            });
            executions.delete(workerSession.id);
            clearDeadlines(executionAttempt.id);
          }, 10_000);
          escalation.unref();
          deadlinesByAttempt.set(executionAttempt.id, [escalation]);
        }, Math.max(
          0,
          Date.parse(workerSession.assignment.authority.validatedAt) +
            workerSession.assignment.timeoutMs -
            Date.now(),
        ));
        deadline.unref();
        deadlinesByAttempt.set(executionAttempt.id, [deadline]);
      }
      if (retainedAnswers.length) {
        orchestration.observeWorkerAnswersReplayed(
          workerSession.id,
          executionAttempt.id,
          retainedAnswers.map((answer) => answer.questionId),
        );
      }
    } catch (error) {
      clearDeadlines(executionAttempt.id);
      ready.reject(error);
      const latestAttempt = orchestration.workerExecutionAttemptView(executionAttempt.id);
      if (latestAttempt?.process) {
        const abandoned = await harness.abandon(latestAttempt.process);
        orchestration.recordWorkerContinuityLoss(
          workerSession.id,
          executionAttempt.id,
          error instanceof Error ? error.message : "Native Harness startup continuity was lost.",
        );
        const recovery = orchestration.recoverWorker(workerSession.id, abandoned.gone);
        if (recovery.kind === "restart") {
          await startExecution(recovery.workerSession, recovery.executionAttempt);
        }
        return;
      }
      orchestration.observeWorkerTerminal({
        workerSessionId: workerSession.id,
        executionAttemptId: executionAttempt.id,
        status: "failed",
        processGone: !latestAttempt?.process,
        detail: error instanceof Error ? error.message : "Worker startup failed.",
      });
      throw error;
    }
  };
  return {
    capabilities() {
      const liveCapabilities = [...executions.keys()].flatMap((workerSessionId) => {
        const worker = orchestration.workerSessionView(workerSessionId);
        const attempt = worker
          ? orchestration.workerExecutionAttemptView(worker.currentExecutionAttemptId)
          : undefined;
        return attempt?.capabilities ? [attempt.capabilities] : [];
      });
      return {
        nativeHarness: harness.selection.nativeHarness,
        effectful: harness.supportsEffectful,
        nativeQuestions: liveCapabilities.some((capabilities) => capabilities.nativeQuestions),
        cancellation: liveCapabilities.some((capabilities) => capabilities.cancellation),
      };
    },

    async delegate(input) {
      const { model, ...assignment } = input;
      const modelSelection: WorkerModelSelection = { ...harness.selection, model };
      const { workerSession, executionAttempt } = orchestration.delegateReadOnlyWorker({
        ...assignment,
        modelSelection,
      });
      void startExecution(workerSession, executionAttempt).catch(() => {});
      return {
        workerSessionId: workerSession.id,
        executionAttemptId: executionAttempt.id,
      };
    },

    async delegateEffectful(input) {
      if (!harness.supportsEffectful) {
        throw new Error(
          `${nativeHarnessName(harness.selection.nativeHarness)} effectful assignments are unavailable because Authorized Write Root enforcement is not proven.`,
        );
      }
      if (!verificationOperations) {
        throw new Error("Effectful Worker delegation requires typed Verification operations.");
      }
      const checkoutIsolation = await checkoutInspector.verify(
        input.targetProjectPath,
        input.timeoutMs,
      );
      const { model, ...assignment } = input;
      const modelSelection: WorkerModelSelection = { ...harness.selection, model };
      const { workerSession, executionAttempt } = orchestration.delegateEffectfulWorker({
        ...assignment,
        modelSelection,
        checkoutIsolation,
      });
      void startExecution(workerSession, executionAttempt).catch(() => {});
      return {
        workerSessionId: workerSession.id,
        executionAttemptId: executionAttempt.id,
      };
    },

    async delegateReview(input) {
      const { model, ...assignment } = input;
      const modelSelection: WorkerModelSelection = { ...harness.selection, model };
      const { workerSession, executionAttempt } = orchestration.delegateReviewWorker({
        ...assignment,
        modelSelection,
      });
      void startExecution(workerSession, executionAttempt).catch(() => {});
      return {
        workerSessionId: workerSession.id,
        executionAttemptId: executionAttempt.id,
      };
    },

    async answer(questionId, ownerTurnId, answers) {
      const pendingQuestion = orchestration.workerQuestionsView().find(
        (question) => question.id === questionId,
      );
      const pendingAttempt = pendingQuestion
        ? orchestration.workerExecutionAttemptView(pendingQuestion.executionAttemptId)
        : undefined;
      if (pendingAttempt?.capabilities?.nativeQuestions === false) {
        throw new Error(
          `${nativeHarnessName(pendingAttempt.modelSelection.nativeHarness)} native questions are unavailable.`,
        );
      }
      const question = orchestration.recordWorkerAnswer(questionId, ownerTurnId, answers);
      const worker = orchestration.workerSessionView(question.workerSessionId);
      if (worker?.currentExecutionAttemptId !== question.executionAttemptId) {
        throw new Error(
          `Worker question ${question.id} retained its answer but its native request lost continuity.`,
        );
      }
      const execution = executions.get(question.workerSessionId);
      if (!execution) {
        throw new Error(
          `Worker Session ${question.workerSessionId} has no live native execution for answer delivery.`,
        );
      }
      void execution
        .answer(question.providerRequestId, answers)
        .then(() => orchestration.observeWorkerAnswerDelivered(question.id))
        .catch(() => {
          // The durable answer remains bound to the question for continuity recovery.
        });
    },

    async cancel(workerSessionId, ownerTurnId, reason) {
      const currentWorker = orchestration.workerSessionView(workerSessionId);
      const currentAttempt = currentWorker
        ? orchestration.workerExecutionAttemptView(currentWorker.currentExecutionAttemptId)
        : undefined;
      if (currentAttempt?.capabilities?.cancellation === false) {
        throw new Error(
          `${nativeHarnessName(currentAttempt.modelSelection.nativeHarness)} cancellation is unavailable.`,
        );
      }
      orchestration.requestWorkerCancellation(workerSessionId, ownerTurnId, reason);
      const execution = executions.get(workerSessionId);
      if (!execution) {
        throw new Error(`Worker Session ${workerSessionId} has no live native execution to interrupt.`);
      }
      void execution.interrupt().catch(async (error: unknown) => {
        const termination = await execution.terminate();
        if (!termination.gone) return;
        const worker = orchestration.workerSessionView(workerSessionId);
        orchestration.observeWorkerTerminal({
          workerSessionId,
          executionAttemptId: worker!.currentExecutionAttemptId,
          status: "interrupted",
          processGone: true,
          detail: error instanceof Error ? error.message : "Native interruption failed.",
        });
        executions.delete(workerSessionId);
      });
    },

    async recover() {
      for (const { workerSession: worker, executionAttempt: attempt } of orchestration.workerRecoveryView()) {
        const abandoned = attempt.process
          ? await harness.abandon(attempt.process)
          : { gone: true };
        if (!sameNativeHarness(attempt.modelSelection, harness.selection)) {
          if (attempt.status !== "continuity-lost") {
            orchestration.recordWorkerContinuityLoss(
              worker.id,
              attempt.id,
              `${nativeHarnessName(attempt.modelSelection.nativeHarness)} continuity is unavailable because the configured Native Harness changed.`,
            );
          }
          continue;
        }
        if (attempt.status !== "continuity-lost" && worker.state !== "cancellation-requested") {
          orchestration.recordWorkerContinuityLoss(
            worker.id,
            attempt.id,
            "The host restart could not prove exact native execution continuity.",
          );
        }
        const recovery = orchestration.recoverWorker(worker.id, abandoned.gone);
        if (recovery.kind === "restart") {
          await startExecution(recovery.workerSession, recovery.executionAttempt);
        }
      }
      for (const { workerSession, executionAttempt } of orchestration.workerVerificationRecoveryView()) {
        await verifySettledWorker(workerSession, executionAttempt);
      }
    },
  };
}

function nativeHarnessName(harness: WorkerModelSelection["nativeHarness"]): string {
  return harness === "codex" ? "Codex" : harness === "claude" ? "Claude" : "Copilot";
}

function sameNativeHarness(
  selection: WorkerModelSelection,
  harness: NativeWorkerHarness["selection"],
): boolean {
  return selection.provider === harness.provider && selection.nativeHarness === harness.nativeHarness;
}
