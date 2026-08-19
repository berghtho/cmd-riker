import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";
import {
  createCodexWorkerHarness,
  createWorkerSupervisor,
  type CodexWorkerExecution,
  type CodexWorkerHarness,
  type WorkerExecutionObserver,
  type WorkerStartRequest,
} from "../src/worker-supervisor/index.ts";

const fakeCodexAppServer = new URL("./support/fake-codex-app-server.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");
const codexSchemaSha256 = "BABFD5C98CD978DD858B4762CDFBC9FBA941E1A0E4053DE0050E4082AE1F075A";

test("a read-only Codex Worker Session starts without occupying the Lead Agent", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let state = openAuthoritativeState(stateDirectory);
  const harness = new FakeCodexHarness();
  harness.pauseStart();
  const supervisor = createWorkerSupervisor(state, harness);

  const started = await supervisor.delegate({
    objective: "Inspect the Target Project architecture.",
    prompt: "Read the repository and report the relevant module seams.",
    targetProjectPath: "C:\\target-project",
    model: "gpt-5.6-sol",
    modelPolicyRevision: "worker-policy-1",
  });

  assert.equal(harness.starts.length, 1);
  assert.equal(harness.starts[0]?.request.readOnly, true);
  assert.notEqual(started.workerSessionId, started.executionAttemptId);
  assert.equal(
    state.readWorkerExecutionAttempt(started.executionAttemptId)?.status,
    "starting",
  );
  assert.deepEqual(state.readWorkerExecutionAttempt(started.executionAttemptId)?.process, {
    pid: 4100,
    startedAt: "2026-08-19T10:00:00.000Z",
  });
  assert.match(
    state.readWorkerExecutionAttempt(started.executionAttemptId)?.dispatch?.leaseId ?? "",
    /^[0-9a-f-]{36}$/,
  );
  harness.releaseStart();
  await waitFor(
    () => state.readWorkerExecutionAttempt(started.executionAttemptId)?.status === "running",
  );
  const worker = state.readWorkerSession(started.workerSessionId);
  const attempt = state.readWorkerExecutionAttempt(started.executionAttemptId);
  assert.equal(worker?.state, "running");
  assert.equal(worker?.currentExecutionAttemptId, started.executionAttemptId);
  assert.equal(attempt?.providerSessionId, "codex-thread-1");
  assert.equal(attempt?.nativeExecutionId, "codex-turn-1");
  assert.deepEqual(attempt?.process, { pid: 4100, startedAt: "2026-08-19T10:00:00.000Z" });
  assert.deepEqual(attempt?.modelSelection, {
    provider: "openai",
    model: "gpt-5.6-sol",
    nativeHarness: "codex",
  });
  assert.equal(attempt?.modelPolicyRevision, "worker-policy-1");
  assert.deepEqual(attempt?.capabilities, {
    readOnly: true,
    nativeQuestions: true,
    cancellation: true,
    exactExecutionResume: "live-connection-only",
    protocolSchemaSha256: codexSchemaSha256,
  });
  assert.equal(harness.starts[0]?.execution.completed, false);

  state.close();
  state = openAuthoritativeState(stateDirectory);
  assert.equal(state.readWorkerSession(started.workerSessionId)?.id, started.workerSessionId);
  assert.equal(
    state.readWorkerExecutionAttempt(started.executionAttemptId)?.providerSessionId,
    "codex-thread-1",
  );
  state.close();
});

test("a native Codex question keeps one durable identity and its answer is recorded before delivery", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-question-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const ownerTurnId = state.appendOwnerMessage("Delegate the inspection and answer its question.");
  const harness = new FakeCodexHarness();
  const supervisor = createWorkerSupervisor(state, harness);
  const started = await supervisor.delegate(workerAssignment());
  await waitFor(
    () => state.readWorkerExecutionAttempt(started.executionAttemptId)?.status === "running",
  );
  const execution = harness.starts[0]!.execution;

  execution.emitQuestion({
    providerRequestId: 0,
    itemId: "question-item-1",
    questions: [
      {
        id: "scope",
        question: "Which module should I inspect?",
        options: [{ label: "State", description: "Inspect durable state." }],
        isOther: true,
      },
    ],
  });

  const question = state.readWorkerQuestions()[0];
  assert.match(question?.id ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(question?.workerSessionId, started.workerSessionId);
  assert.equal(question?.executionAttemptId, started.executionAttemptId);
  assert.equal(question?.providerRequestId, 0);
  assert.equal(question?.status, "open");
  execution.beforeAnswer = () => {
    assert.equal(state.readWorkerQuestion(question!.id)?.status, "answer-recorded");
  };
  execution.pauseAnswer();

  await supervisor.answer(question!.id, ownerTurnId, { scope: ["State"] });

  assert.equal(state.readWorkerQuestion(question!.id)?.status, "answer-recorded");
  execution.releaseAnswer();
  await waitFor(() => state.readWorkerQuestion(question!.id)?.status === "delivered");
  assert.equal(execution.answers.length, 1);
  assert.deepEqual(execution.answers[0], {
    providerRequestId: 0,
    answers: { scope: ["State"] },
  });
  assert.equal(state.readWorkerQuestion(question!.id)?.status, "delivered");
  assert.equal(state.readWorkerSession(started.workerSessionId)?.state, "running");
  await assert.rejects(
    supervisor.answer(question!.id, ownerTurnId, { scope: ["State"] }),
    /already answered/,
  );
  state.close();
});

test("cancellation records intent before interrupt and never claims rollback", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-cancel-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const ownerTurnId = state.appendOwnerMessage("Cancel the delegated inspection.");
  const harness = new FakeCodexHarness();
  const supervisor = createWorkerSupervisor(state, harness);
  const started = await supervisor.delegate(workerAssignment());
  await waitFor(
    () => state.readWorkerExecutionAttempt(started.executionAttemptId)?.status === "running",
  );
  const execution = harness.starts[0]!.execution;
  execution.beforeInterrupt = () => {
    const worker = state.readWorkerSession(started.workerSessionId);
    assert.equal(worker?.state, "cancellation-requested");
    assert.equal(worker?.cancellation?.reason, "Owner no longer needs the inspection.");
  };
  execution.pauseInterrupt();

  await supervisor.cancel(
    started.workerSessionId,
    ownerTurnId,
    "Owner no longer needs the inspection.",
  );

  await waitFor(() => execution.interrupts === 1);
  assert.equal(execution.interrupts, 1);
  assert.equal(state.readWorkerSession(started.workerSessionId)?.state, "cancellation-requested");
  assert.equal(state.readWorkerExecutionAttempt(started.executionAttemptId)?.status, "running");
  execution.releaseInterrupt();
  await execution.emitCompleted("interrupted");
  const cancelled = state.readWorkerSession(started.workerSessionId);
  assert.equal(cancelled?.state, "cancelled");
  assert.equal(state.readWorkerExecutionAttempt(started.executionAttemptId)?.status, "cancelled");
  assert.deepEqual(cancelled?.outcome?.affectedArtifacts, []);
  assert.equal(cancelled?.outcome?.status, "cancelled");
  assert.match(cancelled?.outcome?.verificationResults.join(" ") ?? "", /process is proven gone/);
  assert.equal("rollback" in (cancelled ?? {}), false);
  state.close();
});

test("a Worker-reported structured outcome becomes the durable terminal outcome", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-outcome-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  const harness = new FakeCodexHarness();
  const supervisor = createWorkerSupervisor(state, harness);
  const started = await supervisor.delegate(workerAssignment());
  await waitFor(
    () => state.readWorkerExecutionAttempt(started.executionAttemptId)?.status === "running",
  );
  const execution = harness.starts[0]!.execution;
  execution.observer.output("Read-only result.");

  await execution.emitCompleted("completed", undefined, {
    status: "completed",
    summary: "Architecture inspection completed.",
    affectedArtifacts: [],
    verificationResults: ["Module seams identified."],
  });

  const worker = state.readWorkerSession(started.workerSessionId);
  assert.equal(worker?.state, "completed");
  assert.deepEqual(worker?.outcome, {
    status: "completed",
    summary: "Architecture inspection completed.",
    affectedArtifacts: [],
    materialCommands: [],
    verificationResults: [
      "Module seams identified.",
      "Codex native turn codex-turn-1 ended completed.",
      "The recorded native process is proven gone.",
    ],
    evidence: {
      providerSessionId: "codex-thread-1",
      nativeExecutionId: "codex-turn-1",
      harnessVersion: "codex-cli 0.147.0",
    },
  });
  state.close();
});

test("continuity loss starts a new read-only attempt and fences stale output", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-recovery-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const ownerTurnId = state.appendOwnerMessage("Use State if the Worker asks which module.");
  const harness = new FakeCodexHarness();
  const firstSupervisor = createWorkerSupervisor(state, harness);
  const first = await firstSupervisor.delegate(workerAssignment());
  await waitFor(
    () => state.readWorkerExecutionAttempt(first.executionAttemptId)?.status === "running",
  );
  const firstExecution = harness.starts[0]!.execution;
  firstExecution.emitQuestion({
    providerRequestId: 0,
    itemId: "question-before-restart",
    questions: [
      {
        id: "module",
        question: "Which module?",
        options: [{ label: "State" }],
        isOther: true,
      },
    ],
  });
  const retainedQuestion = state.readWorkerQuestions()[0]!;
  await firstSupervisor.answer(retainedQuestion.id, ownerTurnId, { module: ["State"] });
  await waitFor(() => state.readWorkerQuestion(retainedQuestion.id)?.status === "delivered");

  const restartedSupervisor = createWorkerSupervisor(state, harness);
  await restartedSupervisor.recover();

  const worker = state.readWorkerSession(first.workerSessionId);
  const secondAttempt = state.readWorkerExecutionAttempt(worker!.currentExecutionAttemptId);
  assert.notEqual(secondAttempt?.id, first.executionAttemptId);
  assert.equal(secondAttempt?.generation, 2);
  assert.equal(secondAttempt?.status, "running");
  assert.equal(secondAttempt?.providerSessionId, "codex-thread-2");
  assert.equal(state.readWorkerExecutionAttempt(first.executionAttemptId)?.status, "continuity-lost");
  assert.deepEqual(harness.starts[1]?.request.priorAnswers, [
    {
      questionId: retainedQuestion.id,
      questions: [{ id: "module", question: "Which module?" }],
      answers: { module: ["State"] },
    },
  ]);
  assert.equal(state.readWorkerQuestion(retainedQuestion.id)?.status, "delivered");
  assert.equal(
    state.readWorkerQuestion(retainedQuestion.id)?.deliveredExecutionAttemptId,
    secondAttempt?.id,
  );
  assert.deepEqual(harness.abandoned, [
    {
      pid: 4100,
      startedAt: "2026-08-19T10:00:00.000Z",
    },
  ]);

  firstExecution.observer.output("late stale output");
  await firstExecution.emitCompleted("completed");

  assert.equal(state.readWorkerSession(first.workerSessionId)?.state, "running");
  assert.equal(
    state.readWorkerSession(first.workerSessionId)?.currentExecutionAttemptId,
    secondAttempt?.id,
  );
  assert.match(
    state.readWorkerExecutionAttempt(first.executionAttemptId)?.output ?? "",
    /late stale output/,
  );
  state.close();
});

test("live Codex connection loss automatically replaces the read-only attempt", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-live-loss-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  const harness = new FakeCodexHarness();
  const supervisor = createWorkerSupervisor(state, harness);
  const first = await supervisor.delegate(workerAssignment());
  await waitFor(
    () => state.readWorkerExecutionAttempt(first.executionAttemptId)?.status === "running",
  );

  await harness.starts[0]!.execution.emitFailure(new Error("app-server connection lost"));

  await waitFor(() => harness.starts.length === 2);
  const worker = state.readWorkerSession(first.workerSessionId);
  assert.notEqual(worker?.currentExecutionAttemptId, first.executionAttemptId);
  assert.equal(
    state.readWorkerExecutionAttempt(first.executionAttemptId)?.status,
    "continuity-lost",
  );
  assert.equal(
    state.readWorkerExecutionAttempt(worker!.currentExecutionAttemptId)?.status,
    "running",
  );
  state.close();
});

test("continuity loss during native startup gets one fresh read-only attempt", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-start-loss-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  const harness = new FakeCodexHarness();
  harness.failNextStartAfterProcess();
  const supervisor = createWorkerSupervisor(state, harness);
  const first = await supervisor.delegate(workerAssignment());

  await waitFor(() => harness.starts.length === 2);
  const worker = state.readWorkerSession(first.workerSessionId);
  assert.notEqual(worker?.currentExecutionAttemptId, first.executionAttemptId);
  assert.equal(
    state.readWorkerExecutionAttempt(first.executionAttemptId)?.status,
    "continuity-lost",
  );
  assert.equal(
    state.readWorkerExecutionAttempt(worker!.currentExecutionAttemptId)?.status,
    "running",
  );
  state.close();
});

test("orchestration blocks startup recovery after its bounded read-only attempts", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-start-block-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  const harness = new FakeCodexHarness();
  harness.failNextStartAfterProcess();
  harness.failNextStartAfterProcess();
  harness.failNextStartAfterProcess();
  const supervisor = createWorkerSupervisor(state, harness);
  const started = await supervisor.delegate(workerAssignment());

  await waitFor(() => state.readWorkerSession(started.workerSessionId)?.state === "blocked");

  assert.equal(harness.starts.length, 3);
  const worker = state.readWorkerSession(started.workerSessionId);
  assert.equal(worker?.state, "blocked", JSON.stringify(worker));
  assert.equal(
    state.readWorkerExecutionAttempt(worker!.currentExecutionAttemptId)?.status,
    "blocked",
  );
  assert.match(worker?.outcome?.unresolvedUncertainty ?? "", /turn\/start response lost/);
  state.close();
});

test("an unavailable Codex restart leaves active work explicitly reconciling", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-unavailable-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  const harness = new FakeCodexHarness();
  const supervisor = createWorkerSupervisor(state, harness);
  const started = await supervisor.delegate(workerAssignment());
  await waitFor(
    () => state.readWorkerExecutionAttempt(started.executionAttemptId)?.status === "running",
  );

  createOrchestrationCore(state).reconcileInterruptedWorkers(
    "The Codex capability could not be proven after restart.",
  );

  assert.equal(state.readWorkerSession(started.workerSessionId)?.state, "reconciling");
  assert.equal(
    state.readWorkerExecutionAttempt(started.executionAttemptId)?.status,
    "continuity-lost",
  );
  state.close();
});

test("Codex capability loss is durable, deduplicated, and visibly clearable", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-notice-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let state = openAuthoritativeState(stateDirectory);
  let orchestration = createOrchestrationCore(state);

  assert.equal(
    orchestration.observeCodexCapabilityUnavailable("authentication expired", "C:\\target-project"),
    "recorded",
  );
  assert.equal(
    orchestration.observeCodexCapabilityUnavailable("authentication expired", "C:\\target-project"),
    "deduplicated",
  );
  state.close();

  state = openAuthoritativeState(stateDirectory);
  orchestration = createOrchestrationCore(state);
  assert.equal(state.readCapabilityNotice("codex-worker")?.state, "active");
  assert.equal(state.readCapabilityNotice("codex-worker")?.expectedIdentity, "ChatGPT");
  assert.equal(orchestration.observeCodexCapabilityAvailable(), "cleared");
  assert.equal(state.readCapabilityNotice("codex-worker")?.state, "cleared");
  assert.equal(orchestration.observeCodexCapabilityAvailable(), "unchanged");
  state.close();
});

test("the Codex 0.147.0 adapter enforces read-only policy and carries a native question", async (t) => {
  const harness = createCodexWorkerHarness({
    executable: process.execPath,
    args: [fakeCodexAppServer],
    version: "codex-cli 0.147.0",
  });
  let output = "";
  let terminalStatus: string | undefined;
  let reportedOutcome: Parameters<WorkerExecutionObserver["completed"]>[2];
  let nativeQuestion: Parameters<WorkerExecutionObserver["question"]>[0] | undefined;
  const execution = await harness.start(
    {
      workerSessionId: "worker-session-1",
      executionAttemptId: "execution-attempt-1",
      objective: "Inspect architecture",
      prompt: "Report the module seams.",
      targetProjectPath: process.cwd(),
      model: "gpt-5.6-sol",
      readOnly: true,
    },
    {
      processStarted() {},
      question(request) {
        nativeQuestion = request;
      },
      output(text) {
        output += text;
      },
      completed(status, _detail, reported) {
        terminalStatus = status;
        reportedOutcome = reported;
      },
      failed(error) {
        throw error;
      },
    },
  );
  t.after(() => execution.terminate());

  await waitFor(() => nativeQuestion !== undefined);
  assert.equal(execution.identity.providerSessionId, "thread-read-only-1");
  assert.equal(execution.identity.nativeExecutionId, "turn-read-only-1");
  assert.equal(execution.identity.harnessVersion, "codex-cli 0.147.0");
  assert.equal(nativeQuestion?.providerRequestId, 0);
  assert.equal(nativeQuestion?.questions[0]?.question, "Which module?");
  await execution.answer(0, { module: ["State"] });
  await waitFor(() => terminalStatus !== undefined);
  assert.equal(terminalStatus, "completed");
  assert.equal(output, "Read-only result.");
  assert.deepEqual(reportedOutcome, {
    status: "completed",
    summary: "Read-only result.",
    affectedArtifacts: [],
    verificationResults: ["Architecture inspected."],
  });
});

test("test Codex adapter satisfies the Worker harness contract", async () => {
  await exerciseHarnessContract(new FakeCodexHarness());
});

test("production Codex adapter satisfies the Worker harness contract", async () => {
  await exerciseHarnessContract(
    createCodexWorkerHarness({
      executable: process.execPath,
      args: [fakeCodexAppServer],
      version: "codex-cli 0.147.0",
    }),
  );
});

async function exerciseHarnessContract(harness: CodexWorkerHarness): Promise<void> {
  let processIdentity:
    | {
        process: { pid: number; startedAt: string };
        harnessVersion: string;
        protocolSchemaSha256: string;
      }
    | undefined;
  const execution = await harness.start(
    {
      workerSessionId: "worker-session-contract",
      executionAttemptId: "execution-attempt-contract",
      objective: "Inspect architecture",
      prompt: "Keep inspecting until interrupted.",
      targetProjectPath: process.cwd(),
      model: "gpt-5.6-sol",
      readOnly: true,
    },
    {
      processStarted(identity) {
        processIdentity = identity;
      },
      question() {},
      output() {},
      completed() {},
      failed(error) {
        throw error;
      },
    },
  );
  assert.deepEqual(processIdentity?.process, execution.identity.process);
  assert.equal(processIdentity?.harnessVersion, execution.identity.harnessVersion);
  assert.equal(processIdentity?.protocolSchemaSha256, codexSchemaSha256);
  await execution.interrupt();
  assert.equal((await execution.terminate()).gone, true);
}

class FakeCodexHarness implements CodexWorkerHarness {
  readonly starts: Array<{
    request: WorkerStartRequest;
    observer: WorkerExecutionObserver;
    execution: FakeCodexExecution;
  }> = [];
  readonly abandoned: Array<{ pid: number; startedAt: string }> = [];
  private startGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  private startsToFail = 0;

  async start(
    request: WorkerStartRequest,
    observer: WorkerExecutionObserver,
  ): Promise<CodexWorkerExecution> {
    const execution = new FakeCodexExecution(observer, this.starts.length + 1);
    observer.processStarted({
      process: execution.identity.process,
      harnessVersion: execution.identity.harnessVersion,
      protocolSchemaSha256: execution.identity.protocolSchemaSha256,
    });
    this.starts.push({ request, observer, execution });
    if (this.startsToFail > 0) {
      this.startsToFail -= 1;
      throw new Error("turn/start response lost");
    }
    await this.startGate?.promise;
    return execution;
  }

  async abandon(process: { pid: number; startedAt: string }): Promise<{ gone: boolean }> {
    this.abandoned.push(process);
    return { gone: true };
  }

  pauseStart(): void {
    this.startGate = Promise.withResolvers<void>();
  }

  releaseStart(): void {
    this.startGate?.resolve();
    this.startGate = undefined;
  }

  failNextStartAfterProcess(): void {
    this.startsToFail += 1;
  }
}

class FakeCodexExecution implements CodexWorkerExecution {
  readonly identity;
  completed = false;
  readonly observer: WorkerExecutionObserver;
  readonly answers: Array<{
    providerRequestId: number | string;
    answers: Record<string, string[]>;
  }> = [];
  beforeAnswer: (() => void) | undefined;
  beforeInterrupt: (() => void) | undefined;
  interrupts = 0;
  private answerGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  private interruptGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;

  constructor(observer: WorkerExecutionObserver, sequence: number) {
    this.observer = observer;
    this.identity = {
      providerSessionId: `codex-thread-${sequence}`,
      nativeExecutionId: `codex-turn-${sequence}`,
      process: { pid: 4099 + sequence, startedAt: "2026-08-19T10:00:00.000Z" },
      harnessVersion: "codex-cli 0.147.0",
      protocolSchemaSha256: codexSchemaSha256,
    };
  }

  async answer(
    providerRequestId: number | string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    this.beforeAnswer?.();
    this.answers.push({ providerRequestId, answers });
    await this.answerGate?.promise;
  }

  async interrupt(): Promise<void> {
    this.beforeInterrupt?.();
    this.interrupts += 1;
    await this.interruptGate?.promise;
  }

  async terminate(): Promise<{ gone: boolean }> {
    return { gone: true };
  }

  emitQuestion(request: Parameters<WorkerExecutionObserver["question"]>[0]): void {
    this.observer.question(request);
  }

  async emitCompleted(
    status: Parameters<WorkerExecutionObserver["completed"]>[0],
    detail?: string,
    reportedOutcome?: Parameters<WorkerExecutionObserver["completed"]>[2],
  ): Promise<void> {
    await this.observer.completed(status, detail, reportedOutcome);
  }

  async emitFailure(error: Error): Promise<void> {
    await this.observer.failed(error);
  }

  pauseAnswer(): void {
    this.answerGate = Promise.withResolvers<void>();
  }

  releaseAnswer(): void {
    this.answerGate?.resolve();
    this.answerGate = undefined;
  }

  pauseInterrupt(): void {
    this.interruptGate = Promise.withResolvers<void>();
  }

  releaseInterrupt(): void {
    this.interruptGate?.resolve();
    this.interruptGate = undefined;
  }
}

function workerAssignment() {
  return {
    objective: "Inspect the Target Project architecture.",
    prompt: "Read the repository and report the relevant module seams.",
    targetProjectPath: "C:\\target-project",
    model: "gpt-5.6-sol",
    modelPolicyRevision: "worker-policy-1",
  };
}

function ownerConfiguration() {
  return {
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, "timed out waiting for Codex adapter event");
}
