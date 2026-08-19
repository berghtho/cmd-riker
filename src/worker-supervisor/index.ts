import {
  createOrchestrationCore,
  type OrchestrationState,
  type WorkerExecutionAttempt,
  type WorkerReportedOutcome,
  type WorkerSession,
} from "../orchestration-core/index.ts";

export {
  createCodexWorkerHarness,
  resolveCodexRuntime,
  type CodexRuntime,
} from "./codex-app-server.ts";

export type WorkerStartRequest = {
  workerSessionId: string;
  executionAttemptId: string;
  objective: string;
  prompt: string;
  targetProjectPath: string;
  model: string;
  readOnly: true;
  priorAnswers?: Array<{
    questionId: string;
    questions: Array<{ id: string; question: string }>;
    answers: Record<string, string[]>;
  }>;
};

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
  completed(
    status: "completed" | "failed" | "interrupted",
    detail?: string,
    reportedOutcome?: WorkerReportedOutcome,
  ): void | Promise<void>;
  failed(error: Error): void | Promise<void>;
};

export type CodexWorkerExecution = {
  identity: {
    providerSessionId: string;
    nativeExecutionId: string;
    process: { pid: number; startedAt: string };
    harnessVersion: string;
    protocolSchemaSha256: string;
  };
  answer(providerRequestId: number | string, answers: Record<string, string[]>): Promise<void>;
  interrupt(): Promise<void>;
  terminate(): Promise<{ gone: boolean }>;
};

export interface CodexWorkerHarness {
  start(
    request: WorkerStartRequest,
    observer: WorkerExecutionObserver,
  ): Promise<CodexWorkerExecution>;
  abandon(process: { pid: number; startedAt: string }): Promise<{ gone: boolean }>;
}

export interface WorkerSupervisor {
  delegate(input: {
    objective: string;
    prompt: string;
    targetProjectPath: string;
    model: string;
    modelPolicyRevision: string;
    commitmentId?: string;
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
  harness: CodexWorkerHarness,
): WorkerSupervisor {
  const orchestration = createOrchestrationCore(state);
  const executions = new Map<string, CodexWorkerExecution>();
  const outputByAttempt = new Map<string, string>();
  const commandsByAttempt = new Map<string, string[]>();
  const startExecution = async (
    workerSession: WorkerSession,
    executionAttempt: WorkerExecutionAttempt,
  ): Promise<void> => {
    orchestration.claimWorkerLaunch(workerSession.id, executionAttempt.id);
    const ready = Promise.withResolvers<CodexWorkerExecution>();
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
      const execution = await harness.start(
        {
          workerSessionId: workerSession.id,
          executionAttemptId: executionAttempt.id,
          objective: workerSession.assignment.objective,
          prompt: workerSession.assignment.prompt,
          targetProjectPath: workerSession.assignment.targetProjectPath,
          model: executionAttempt.modelSelection.model,
          readOnly: true,
          ...(retainedAnswers.length ? { priorAnswers: retainedAnswers } : {}),
        },
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
          async completed(status, detail, reportedOutcome) {
            const liveExecution = await ready.promise;
            const termination = await liveExecution.terminate();
            orchestration.observeWorkerTerminal({
              workerSessionId: workerSession.id,
              executionAttemptId: executionAttempt.id,
              status,
              processGone: termination.gone,
              ...(outputByAttempt.get(executionAttempt.id)
                ? { output: outputByAttempt.get(executionAttempt.id)! }
                : {}),
              ...(detail ? { detail } : {}),
              ...(commandsByAttempt.get(executionAttempt.id)
                ? { materialCommands: commandsByAttempt.get(executionAttempt.id)! }
                : {}),
              ...(reportedOutcome ? { reportedOutcome } : {}),
            });
            executions.delete(workerSession.id);
            outputByAttempt.delete(executionAttempt.id);
            commandsByAttempt.delete(executionAttempt.id);
          },
          async failed(error) {
            let liveExecution: CodexWorkerExecution;
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
            const recovery = orchestration.recoverReadOnlyWorker(
              workerSession.id,
              termination.gone,
            );
            executions.delete(workerSession.id);
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
        ...execution.identity,
      });
      executions.set(workerSession.id, execution);
      ready.resolve(execution);
      if (retainedAnswers.length) {
        orchestration.observeWorkerAnswersReplayed(
          workerSession.id,
          executionAttempt.id,
          retainedAnswers.map((answer) => answer.questionId),
        );
      }
    } catch (error) {
      ready.reject(error);
      const latestAttempt = orchestration.workerExecutionAttemptView(executionAttempt.id);
      if (latestAttempt?.process) {
        const abandoned = await harness.abandon(latestAttempt.process);
        orchestration.recordWorkerContinuityLoss(
          workerSession.id,
          executionAttempt.id,
          error instanceof Error ? error.message : "Codex startup continuity was lost.",
        );
        const recovery = orchestration.recoverReadOnlyWorker(workerSession.id, abandoned.gone);
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
        detail: error instanceof Error ? error.message : "Codex Worker startup failed.",
      });
      throw error;
    }
  };
  return {
    async delegate(input) {
      const { workerSession, executionAttempt } = orchestration.delegateReadOnlyCodex(input);
      void startExecution(workerSession, executionAttempt).catch(() => {});
      return {
        workerSessionId: workerSession.id,
        executionAttemptId: executionAttempt.id,
      };
    },

    async answer(questionId, ownerTurnId, answers) {
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
          `Worker Session ${question.workerSessionId} has no live Codex execution for answer delivery.`,
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
      orchestration.requestWorkerCancellation(workerSessionId, ownerTurnId, reason);
      const execution = executions.get(workerSessionId);
      if (!execution) {
        throw new Error(`Worker Session ${workerSessionId} has no live Codex execution to interrupt.`);
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
          detail: error instanceof Error ? error.message : "Codex interruption failed.",
        });
        executions.delete(workerSessionId);
      });
    },

    async recover() {
      for (const { workerSession: worker, executionAttempt: attempt } of orchestration.workerRecoveryView()) {
        const abandoned = attempt.process
          ? await harness.abandon(attempt.process)
          : { gone: true };
        if (attempt.status !== "continuity-lost" && worker.state !== "cancellation-requested") {
          orchestration.recordWorkerContinuityLoss(
            worker.id,
            attempt.id,
            "The host restart could not prove exact native execution continuity.",
          );
        }
        const recovery = orchestration.recoverReadOnlyWorker(worker.id, abandoned.gone);
        if (recovery.kind === "restart") {
          await startExecution(recovery.workerSession, recovery.executionAttempt);
        }
      }
    },
  };
}
