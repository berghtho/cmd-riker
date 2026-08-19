import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import {
  createOrchestrationCore,
  type WorkerNativeHarnessSelection,
} from "../src/orchestration-core/index.ts";
import {
  createTargetProjectOperations,
  type TaskCli,
} from "../src/target-project-operations/index.ts";
import {
  createCodexWorkerHarness,
  createClaudeWorkerHarness,
  createCopilotWorkerHarness,
  createWorkerSupervisor,
  NativeEffectfulCheckoutInspector,
  proveCodexWorkspaceWriteIsolation,
  resolveCodexRuntime,
  type CodexWorkerExecution,
  type CodexWorkerHarness,
  type EffectfulCheckoutInspector,
  type NativeWorkerExecution,
  type NativeWorkerHarness,
  type WorkerExecutionObserver,
  type WorkerStartRequest,
} from "../src/worker-supervisor/index.ts";

const fakeCodexAppServer = new URL("./support/fake-codex-app-server.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");
const fakeClaudeProcess = new URL("./support/fake-claude-process.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");
const fakeCopilotAcp = new URL("./support/fake-copilot-acp.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");
const codexSchemaSha256 = "BABFD5C98CD978DD858B4762CDFBC9FBA941E1A0E4053DE0050E4082AE1F075A";
const execFileAsync = promisify(execFile);

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
    providerSessionResume: "unavailable",
    providerSessionDeletion: false,
    nativeChildControl: false,
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

test("Claude and Copilot Workers persist honest native capability limits", async (t) => {
  const cases = [
    {
      provider: "anthropic" as const,
      nativeHarness: "claude" as const,
      model: "claude-sonnet-5",
      nativeQuestions: false,
      cancellation: true,
      providerSessionResume: "conversation-replay-only" as const,
    },
    {
      provider: "github" as const,
      nativeHarness: "copilot" as const,
      model: "auto",
      nativeQuestions: false,
      cancellation: false,
      providerSessionResume: "conversation-replay-only" as const,
    },
  ];

  for (const expected of cases) {
    const stateDirectory = await mkdtemp(join(tmpdir(), `cmd-riker-${expected.nativeHarness}-test-`));
    t.after(() => rm(stateDirectory, { recursive: true, force: true }));
    const state = openAuthoritativeState(stateDirectory);
    const harness = new FakeLimitedNativeHarness(expected);
    const supervisor = createWorkerSupervisor(state, harness);

    const started = await supervisor.delegate({
      objective: `Inspect through ${expected.nativeHarness}.`,
      prompt: "Report the public module seams.",
      targetProjectPath: "C:\\target-project",
      model: expected.model,
      modelPolicyRevision: `${expected.nativeHarness}-policy-1`,
    });
    await waitFor(
      () => state.readWorkerExecutionAttempt(started.executionAttemptId)?.status === "running",
    );

    const attempt = state.readWorkerExecutionAttempt(started.executionAttemptId);
    assert.deepEqual(attempt?.modelSelection, {
      provider: expected.provider,
      model: expected.model,
      nativeHarness: expected.nativeHarness,
    });
    assert.equal(attempt?.providerSessionId, `${expected.nativeHarness}-session-1`);
    assert.equal(attempt?.nativeExecutionId, `${expected.nativeHarness}-execution-1`);
    assert.deepEqual(attempt?.capabilities, {
      readOnly: true,
      nativeQuestions: expected.nativeQuestions,
      cancellation: expected.cancellation,
      providerSessionResume: expected.providerSessionResume,
      providerSessionDeletion: false,
      nativeChildControl: false,
      exactExecutionResume: "live-connection-only",
      protocolSchemaSha256: `${expected.nativeHarness}-schema`,
    });

    if (!expected.cancellation) {
      await assert.rejects(
        supervisor.cancel(started.workerSessionId, "owner-turn", "Stop the Worker."),
        /Copilot cancellation is unavailable/,
      );
      assert.equal(state.readWorkerSession(started.workerSessionId)?.state, "running");
      assert.equal(harness.execution.interrupts, 0);
    }
    state.close();
  }
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

test("an effectful Codex assignment is bounded before dispatch and accepted from typed Verification", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-effectful-worker-state-test-"));
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-effectful-worker-project-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await mkdir(join(checkout, ".git"));
  await mkdir(join(checkout, "src"));
  const taskfile = join(checkout, "Taskfile.yml");
  await writeFile(taskfile, "version: '3'\ntasks:\n  test:\n    cmds: []\n");
  await writeFile(
    join(checkout, "cmd-riker.operations.json"),
    JSON.stringify({
      version: 1,
      operations: {
        test: { task: "test", platforms: [declaredPlatform()], artifacts: [] },
      },
    }),
  );

  let state = openAuthoritativeState(stateDirectory);
  state.initialize({ ...ownerConfiguration(), targetProject: { path: checkout } });
  const orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Implement and verify the bounded change.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The bounded Target Project change passes its declared tests.",
    criteria: [
      {
        kind: "target-project-operation",
        description: "The declared test operation succeeds without uncertainty.",
        operation: "test",
      },
    ],
  });
  let started: { workerSessionId: string; executionAttemptId: string };
  const verificationStarted = Promise.withResolvers<void>();
  const verificationGate = Promise.withResolvers<void>();
  const taskCli: TaskCli = {
    async inspect() {
      return { version: "Task version: v3.53.1", taskfile, tasks: ["test"] };
    },
    async run(input) {
      const operation = state.readTargetProjectOperationAttempt(input.operationAttemptId);
      assert.equal(operation?.causedByWorker?.workerSessionId, started.workerSessionId);
      assert.equal(operation?.causedByWorker?.executionAttemptId, started.executionAttemptId);
      verificationStarted.resolve();
      await verificationGate.promise;
      return { exitCode: 0, timedOut: false };
    },
  };
  const operations = createTargetProjectOperations(state, taskCli, {
    async verify() {
      return { root: checkout };
    },
  });
  const harness = new FakeCodexHarness();
  harness.pauseEffectDispatch();
  const supervisor = createWorkerSupervisor(
    state,
    harness,
    operations,
    effectfulCheckoutInspector(checkout),
  );

  started = await supervisor.delegateEffectful({
    objective: "Implement the bounded Target Project change.",
    prompt: "Create src/index.ts and leave the checkout ready for Verification.",
    targetProjectPath: checkout,
    model: "gpt-5.6-sol",
    modelPolicyRevision: "worker-policy-1",
    commitmentId: commitment.id,
    targets: ["src/index.ts"],
    timeoutMs: 120_000,
    verification: { operation: "test", workingDirectory: checkout, timeoutMs: 30_000 },
  });

  const pendingWorker = state.readWorkerSession(started.workerSessionId);
  const pendingAttempt = state.readWorkerExecutionAttempt(started.executionAttemptId);
  assert.equal(pendingWorker?.assignment.readOnly, false);
  assert.deepEqual(pendingWorker?.assignment.authorizedWriteRoots, [checkout]);
  assert.deepEqual(pendingWorker?.assignment.effectClasses, [
    "filesystem-write",
    "bounded-process-execution",
  ]);
  assert.deepEqual(pendingWorker?.assignment.checkoutIsolation, {
    root: checkout,
    baselineCommit: "a".repeat(40),
    isolation: { kind: "branch", branch: "feat/test" },
  });
  assert.equal(state.readEffectIntent(pendingAttempt!.effectIntentId!)?.status, "pending");
  harness.releaseEffectDispatch();
  await waitFor(
    () => state.readWorkerExecutionAttempt(started.executionAttemptId)?.status === "running",
  );
  assert.equal(state.readEffectIntent(pendingAttempt!.effectIntentId!)?.status, "dispatching");

  await writeFile(join(checkout, "src", "index.ts"), "export const answer = 42;\n");
  const completion = harness.starts[0]!.execution.emitCompleted("completed", undefined, {
    status: "completed",
    summary: "Implemented the bounded change.",
    affectedArtifacts: ["src/index.ts"],
    verificationResults: ["Implementation completed; host Verification remains required."],
  });
  await verificationStarted.promise;
  const conflictingTurnId = state.appendOwnerMessage("Start a conflicting change.");
  const conflictingCommitment = orchestration.recordCommitment(conflictingTurnId, {
    outcome: "A conflicting change passes tests.",
    criteria: [
      {
        kind: "target-project-operation",
        description: "The declared test operation succeeds.",
        operation: "test",
      },
    ],
  });
  await assert.rejects(
    supervisor.delegateEffectful({
      objective: "Implement a conflicting change.",
      prompt: "Change src/index.ts again.",
      targetProjectPath: checkout,
      model: "gpt-5.6-sol",
      modelPolicyRevision: "worker-policy-1",
      commitmentId: conflictingCommitment.id,
      targets: ["src/index.ts"],
      timeoutMs: 120_000,
      verification: { operation: "test", workingDirectory: checkout, timeoutMs: 30_000 },
    }),
    /conflicting Target Project effect.*Authorized Write Root/,
  );
  verificationGate.resolve();
  await completion;

  const settledEffect = state.readEffectIntent(pendingAttempt!.effectIntentId!);
  assert.equal(settledEffect?.status, "succeeded");
  assert.equal(settledEffect?.kind, "worker-assignment");
  assert.match(
    settledEffect?.kind === "worker-assignment"
      ? settledEffect.verificationOperationAttemptId ?? ""
      : "",
    /^[0-9a-f-]{36}$/,
  );
  assert.equal(state.readCommitment(commitment.id)?.state, "accepted");
  assert.equal(state.readCommitment(commitment.id)?.verification?.passed, true);
  state.close();
  state = openAuthoritativeState(stateDirectory);
  assert.equal(state.readWorkerSession(started.workerSessionId)?.assignment.readOnly, false);
  assert.equal(state.readEffectIntent(pendingAttempt!.effectIntentId!)?.status, "succeeded");
  assert.equal(state.readCommitment(commitment.id)?.state, "accepted");
  state.close();
});

test("effectful Worker continuity loss becomes unknown and is never replayed", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-effectful-worker-loss-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Implement the bounded change.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The bounded change passes tests.",
    criteria: [
      {
        kind: "target-project-operation",
        description: "Tests pass.",
        operation: "test",
      },
    ],
  });
  const harness = new FakeCodexHarness();
  const supervisor = createWorkerSupervisor(
    state,
    harness,
    {
      async execute() {
        assert.fail("An uncertain Worker effect must not launch Verification.");
      },
    },
    effectfulCheckoutInspector("C:\\target-project"),
  );
  const started = await supervisor.delegateEffectful({
    objective: "Implement the bounded change.",
    prompt: "Change src/index.ts.",
    targetProjectPath: "C:\\target-project",
    model: "gpt-5.6-sol",
    modelPolicyRevision: "worker-policy-1",
    commitmentId: commitment.id,
    targets: ["src/index.ts"],
    timeoutMs: 120_000,
    verification: {
      operation: "test",
      workingDirectory: "C:\\target-project",
      timeoutMs: 30_000,
    },
  });
  await waitFor(
    () => state.readWorkerExecutionAttempt(started.executionAttemptId)?.status === "running",
  );

  await harness.starts[0]!.execution.emitFailure(new Error("app-server connection lost"));

  const attempt = state.readWorkerExecutionAttempt(started.executionAttemptId);
  assert.equal(harness.starts.length, 1);
  assert.equal(state.readEffectIntent(attempt!.effectIntentId!)?.status, "unknown");
  assert.equal(state.readWorkerSession(started.workerSessionId)?.state, "reconciling");
  assert.match(
    state.readWorkerSession(started.workerSessionId)?.outcome?.unresolvedUncertainty ?? "",
    /replay is forbidden/,
  );
  state.close();
});

test("passing narration cannot accept an effectful assignment with no observed checkout change", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-effectful-worker-noop-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Implement the bounded change.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The bounded change passes tests.",
    criteria: [{ kind: "target-project-operation", description: "Tests pass.", operation: "test" }],
  });
  const harness = new FakeCodexHarness();
  const supervisor = createWorkerSupervisor(
    state,
    harness,
    {
      async execute() {
        assert.fail("A no-op Worker outcome must not launch Verification.");
      },
    },
    effectfulCheckoutInspector("C:\\target-project", []),
  );
  const started = await supervisor.delegateEffectful({
    objective: "Implement the bounded change.",
    prompt: "Change src/index.ts.",
    targetProjectPath: "C:\\target-project",
    model: "gpt-5.6-sol",
    modelPolicyRevision: "worker-policy-1",
    commitmentId: commitment.id,
    targets: ["src/index.ts"],
    timeoutMs: 120_000,
    verification: {
      operation: "test",
      workingDirectory: "C:\\target-project",
      timeoutMs: 30_000,
    },
  });
  await waitFor(
    () => state.readWorkerExecutionAttempt(started.executionAttemptId)?.status === "running",
  );

  await harness.starts[0]!.execution.emitCompleted("completed", undefined, {
    status: "completed",
    summary: "Claimed to implement the change.",
    affectedArtifacts: ["src/index.ts"],
    verificationResults: ["Claimed completion."],
  });

  const attempt = state.readWorkerExecutionAttempt(started.executionAttemptId);
  assert.equal(state.readEffectIntent(attempt!.effectIntentId!)?.status, "unknown");
  assert.equal(state.readWorkerSession(started.workerSessionId)?.state, "reconciling");
  assert.match(
    state.readWorkerSession(started.workerSessionId)?.outcome?.unresolvedUncertainty ?? "",
    /No bounded Target Project change was observed/,
  );
  assert.equal(state.readCommitment(commitment.id)?.state, "active");
  state.close();
});

test("an effectful Worker deadline interrupts the native attempt and preserves effect uncertainty", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-effectful-worker-timeout-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Implement the bounded change.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The bounded change passes tests.",
    criteria: [{ kind: "target-project-operation", description: "Tests pass.", operation: "test" }],
  });
  const harness = new FakeCodexHarness();
  const supervisor = createWorkerSupervisor(
    state,
    harness,
    {
      async execute() {
        assert.fail("A timed-out Worker effect must not launch Verification.");
      },
    },
    effectfulCheckoutInspector("C:\\target-project"),
  );
  const started = await supervisor.delegateEffectful({
    objective: "Implement the bounded change.",
    prompt: "Change src/index.ts.",
    targetProjectPath: "C:\\target-project",
    model: "gpt-5.6-sol",
    modelPolicyRevision: "worker-policy-1",
    commitmentId: commitment.id,
    targets: ["src/index.ts"],
    timeoutMs: 20,
    verification: {
      operation: "test",
      workingDirectory: "C:\\target-project",
      timeoutMs: 30_000,
    },
  });
  await waitFor(() => harness.starts[0]!.execution.interrupts === 1);
  assert.equal(state.readWorkerSession(started.workerSessionId)?.cancellation?.kind, "deadline");

  await harness.starts[0]!.execution.emitCompleted("completed", undefined, {
    status: "completed",
    summary: "Completed after the deadline.",
    affectedArtifacts: ["src/index.ts"],
    verificationResults: ["Late completion must not be accepted."],
  });

  const attempt = state.readWorkerExecutionAttempt(started.executionAttemptId);
  assert.equal(attempt?.status, "timed-out");
  assert.equal(attempt?.outcome?.status, "timed-out");
  assert.equal(state.readEffectIntent(attempt!.effectIntentId!)?.status, "unknown");
  assert.equal(state.readWorkerSession(started.workerSessionId)?.state, "reconciling");
  state.close();
});

test("restart resumes the reserved Verification handoff without replaying the Worker", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-verification-recovery-state-"));
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-worker-verification-recovery-project-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await mkdir(join(checkout, ".git"));
  await mkdir(join(checkout, "src"));
  const taskfile = join(checkout, "Taskfile.yml");
  await writeFile(taskfile, "version: '3'\ntasks:\n  test:\n    cmds: []\n");
  await writeFile(
    join(checkout, "cmd-riker.operations.json"),
    JSON.stringify({
      version: 1,
      operations: { test: { task: "test", platforms: [declaredPlatform()], artifacts: [] } },
    }),
  );
  let state = openAuthoritativeState(stateDirectory);
  state.initialize({ ...ownerConfiguration(), targetProject: { path: checkout } });
  let orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Implement and verify the bounded change.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The recovered Verification accepts the bounded change.",
    criteria: [{ kind: "target-project-operation", description: "Tests pass.", operation: "test" }],
  });
  const harness = new FakeCodexHarness();
  const interruptedSupervisor = createWorkerSupervisor(
    state,
    harness,
    {
      async execute() {
        throw new Error("host stopped before Verification dispatch");
      },
    },
    effectfulCheckoutInspector(checkout),
  );
  const started = await interruptedSupervisor.delegateEffectful({
    objective: "Implement the bounded change.",
    prompt: "Change src/index.ts.",
    targetProjectPath: checkout,
    model: "gpt-5.6-sol",
    modelPolicyRevision: "worker-policy-1",
    commitmentId: commitment.id,
    targets: ["src/index.ts"],
    timeoutMs: 120_000,
    verification: { operation: "test", workingDirectory: checkout, timeoutMs: 30_000 },
  });
  await waitFor(
    () => state.readWorkerExecutionAttempt(started.executionAttemptId)?.status === "running",
  );
  await writeFile(join(checkout, "src", "index.ts"), "export const recovered = true;\n");
  await assert.rejects(
    harness.starts[0]!.execution.emitCompleted("completed", undefined, {
      status: "completed",
      summary: "Implemented the bounded change.",
      affectedArtifacts: ["src/index.ts"],
      verificationResults: ["Ready for host Verification."],
    }),
    /host stopped before Verification dispatch/,
  );
  const effectIntentId = state.readWorkerExecutionAttempt(started.executionAttemptId)!.effectIntentId!;
  assert.equal(state.readEffectIntent(effectIntentId)?.status, "succeeded");
  assert.equal(orchestration.workerVerificationRecoveryView().length, 1);
  state.close();

  state = openAuthoritativeState(stateDirectory);
  orchestration = createOrchestrationCore(state);
  orchestration.reconcileInterruptedCommitments();
  assert.equal(state.readCommitment(commitment.id)?.condition, undefined);
  const operations = createTargetProjectOperations(
    state,
    {
      async inspect() {
        return { version: "Task version: v3.53.1", taskfile, tasks: ["test"] };
      },
      async run() {
        return { exitCode: 0, timedOut: false };
      },
    },
    {
      async verify() {
        return { root: checkout };
      },
    },
  );
  const recoveredSupervisor = createWorkerSupervisor(
    state,
    harness,
    operations,
    effectfulCheckoutInspector(checkout),
  );

  await recoveredSupervisor.recover();

  assert.equal(harness.starts.length, 1);
  assert.equal(state.readCommitment(commitment.id)?.state, "accepted");
  const settledEffect = state.readEffectIntent(effectIntentId);
  assert.match(
    settledEffect?.kind === "worker-assignment"
      ? settledEffect.verificationOperationAttemptId ?? ""
      : "",
    /^[0-9a-f-]{36}$/,
  );
  state.close();
});

test("effectful Workers with the same Authorized Write Root are explicitly ordered", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-effectful-worker-conflict-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const orchestration = createOrchestrationCore(state);
  const firstTurnId = state.appendOwnerMessage("Implement the first bounded change.");
  const firstCommitment = orchestration.recordCommitment(firstTurnId, {
    outcome: "The first change passes tests.",
    criteria: [{ kind: "target-project-operation", description: "Tests pass.", operation: "test" }],
  });
  const secondTurnId = state.appendOwnerMessage("Implement the second bounded change.");
  const secondCommitment = orchestration.recordCommitment(secondTurnId, {
    outcome: "The second change passes tests.",
    criteria: [{ kind: "target-project-operation", description: "Tests pass.", operation: "test" }],
  });
  const harness = new FakeCodexHarness();
  const supervisor = createWorkerSupervisor(
    state,
    harness,
    {
      async execute() {
        assert.fail("This test does not settle the first assignment.");
      },
    },
    effectfulCheckoutInspector("C:\\target-project"),
  );
  const assignment = (commitmentId: string) => ({
    objective: "Implement one bounded change.",
    prompt: "Change one assigned file.",
    targetProjectPath: "C:\\target-project",
    model: "gpt-5.6-sol",
    modelPolicyRevision: "worker-policy-1",
    commitmentId,
    targets: ["src/index.ts"],
    timeoutMs: 120_000,
    verification: {
      operation: "test" as const,
      workingDirectory: "C:\\target-project",
      timeoutMs: 30_000,
    },
  });

  await supervisor.delegateEffectful(assignment(firstCommitment.id));
  await assert.rejects(
    supervisor.delegateEffectful(assignment(secondCommitment.id)),
    /conflicting Target Project effect.*Authorized Write Root/,
  );
  assert.equal(harness.starts.length, 1);
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

test("the Claude adapter completes a bounded read-only assignment with honest capabilities", async (t) => {
  const harness = createClaudeWorkerHarness({
    executable: process.execPath,
    args: [fakeClaudeProcess],
    version: "2.1.229 (Claude Code)",
  });
  let output = "";
  let terminalStatus: string | undefined;
  let reportedOutcome: Parameters<WorkerExecutionObserver["completed"]>[2];
  const execution = await harness.start(
    {
      workerSessionId: "worker-session-claude-1",
      executionAttemptId: "execution-attempt-claude-1",
      objective: "Inspect architecture",
      prompt: "Report the module seams.",
      targetProjectPath: process.cwd(),
      model: "claude-sonnet-5",
      readOnly: true,
    },
    {
      processStarted() {},
      question() {
        assert.fail("Claude questions are unavailable through this direct transport.");
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

  assert.equal(execution.identity.providerSessionId, "claude-session-1");
  assert.match(execution.identity.nativeExecutionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(execution.identity.capabilities, {
    readOnly: true,
    nativeQuestions: false,
    cancellation: true,
    providerSessionResume: "conversation-replay-only",
    providerSessionDeletion: false,
    nativeChildControl: false,
    exactExecutionResume: "live-connection-only",
    protocolSchemaSha256: execution.identity.protocolSchemaSha256,
  });
  await waitFor(() => terminalStatus !== undefined);
  assert.equal(terminalStatus, "completed");
  assert.equal(output, "Claude read-only result.");
  assert.deepEqual(reportedOutcome, {
    status: "completed",
    summary: "Claude read-only result.",
    affectedArtifacts: [],
    verificationResults: ["Architecture inspected."],
  });
});

test("the Copilot ACP adapter completes a bounded assignment without simulating lifecycle gaps", async (t) => {
  const harness = createCopilotWorkerHarness({
    executable: process.execPath,
    args: [fakeCopilotAcp],
    version: "GitHub Copilot CLI 1.0.80.",
  });
  let output = "";
  let terminalStatus: string | undefined;
  let reportedOutcome: Parameters<WorkerExecutionObserver["completed"]>[2];
  const execution = await harness.start(
    {
      workerSessionId: "worker-session-copilot-1",
      executionAttemptId: "execution-attempt-copilot-1",
      objective: "Inspect architecture",
      prompt: "Report the module seams.",
      targetProjectPath: process.cwd(),
      model: "auto",
      readOnly: true,
    },
    {
      processStarted() {},
      question() {
        assert.fail("Copilot elicitation is unavailable through the proven ACP seam.");
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

  assert.equal(execution.identity.providerSessionId, "copilot-session-1");
  assert.match(execution.identity.nativeExecutionId, /^session\/prompt:\d+$/);
  assert.deepEqual(execution.identity.capabilities, {
    readOnly: true,
    nativeQuestions: false,
    cancellation: false,
    providerSessionResume: "conversation-replay-only",
    providerSessionDeletion: false,
    nativeChildControl: false,
    exactExecutionResume: "live-connection-only",
    protocolSchemaSha256: execution.identity.protocolSchemaSha256,
  });
  await assert.rejects(execution.interrupt(), /Copilot cancellation is unavailable/);
  await assert.rejects(execution.answer("elicitation-1", {}), /questions are unavailable/);
  await waitFor(() => terminalStatus !== undefined);
  assert.equal(terminalStatus, "completed");
  assert.equal(output, "Copilot read-only result.");
  assert.deepEqual(reportedOutcome, {
    status: "completed",
    summary: "Copilot read-only result.",
    affectedArtifacts: [],
    verificationResults: ["Architecture inspected."],
  });
});

test("the Codex 0.147.0 adapter proves workspace-write isolation before effect dispatch", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-codex-workspace-write-test-"));
  const harness = createCodexWorkerHarness({
    executable: process.execPath,
    args: [fakeCodexAppServer],
    version: "codex-cli 0.147.0",
  });
  let effectDispatches = 0;
  let terminalStatus: string | undefined;
  const execution = await harness.start(
    {
      workerSessionId: "worker-session-effectful-adapter",
      executionAttemptId: "execution-attempt-effectful-adapter",
      objective: "Implement the bounded change",
      prompt: "Change src/index.ts.",
      targetProjectPath: checkout,
      model: "gpt-5.6-sol",
      readOnly: false,
      targets: ["src/index.ts"],
      authorizedWriteRoot: checkout,
      timeoutMs: 120_000,
      recoveryConstraint: "reconcile-before-replay",
    },
    {
      processStarted() {},
      effectDispatchStarted() {
        effectDispatches += 1;
      },
      question() {},
      output() {},
      completed(status) {
        terminalStatus = status;
      },
      failed(error) {
        throw error;
      },
    },
  );
  t.after(async () => {
    await execution.terminate();
    await rm(checkout, { recursive: true, force: true });
  });

  assert.equal(effectDispatches, 1);
  assert.equal(execution.identity.writeIsolation, "codex-windows-workspace-write");
  await waitFor(() => terminalStatus !== undefined);
  assert.equal(terminalStatus, "completed");
});

test("the Codex adapter fails closed before effect dispatch when Windows isolation is not ready", async () => {
  const harness = createCodexWorkerHarness({
    executable: process.execPath,
    args: [fakeCodexAppServer, "notConfigured"],
    version: "codex-cli 0.147.0",
  });
  let effectDispatches = 0;
  await assert.rejects(
    harness.start(
      {
        workerSessionId: "worker-session-unready-isolation",
        executionAttemptId: "execution-attempt-unready-isolation",
        objective: "Implement the bounded change",
        prompt: "Change src/index.ts.",
        targetProjectPath: process.cwd(),
        model: "gpt-5.6-sol",
        readOnly: false,
        targets: ["src/index.ts"],
        authorizedWriteRoot: process.cwd(),
        timeoutMs: 120_000,
        recoveryConstraint: "reconcile-before-replay",
      },
      {
        processStarted() {},
        effectDispatchStarted() {
          effectDispatches += 1;
        },
        question() {},
        output() {},
        completed() {},
        failed() {},
      },
    ),
    /Windows write isolation is notConfigured/,
  );
  assert.equal(effectDispatches, 0);
});

test("installed Codex technically denies a real out-of-root write", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows restricted-token isolation is Windows-only.");
    return;
  }
  let runtime: Awaited<ReturnType<typeof resolveCodexRuntime>>;
  try {
    runtime = await resolveCodexRuntime();
  } catch (error) {
    t.skip(`Pinned Codex runtime unavailable: ${error instanceof Error ? error.message : error}`);
    return;
  }
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-real-codex-isolation-test-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));

  await proveCodexWorkspaceWriteIsolation(runtime, checkout);
});

test("native checkout inspection requires a clean isolated branch and observes its real diff", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-isolated-checkout-test-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await execGit(checkout, ["init", "-b", "main"]);
  await execGit(checkout, ["config", "user.name", "CMD Riker Test"]);
  await execGit(checkout, ["config", "user.email", "cmd-riker@example.invalid"]);
  await writeFile(join(checkout, "tracked.txt"), "baseline\n");
  await execGit(checkout, ["add", "tracked.txt"]);
  await execGit(checkout, ["commit", "-m", "baseline"]);
  await execGit(checkout, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await execGit(checkout, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  const inspector = new NativeEffectfulCheckoutInspector();

  await assert.rejects(
    inspector.verify(checkout, 5_000),
    /isolated non-default branch or secondary worktree/,
  );
  await execGit(checkout, ["switch", "-c", "feat/test"]);
  const isolated = await inspector.verify(checkout, 5_000);
  assert.equal(isolated.root, checkout);
  assert.equal(isolated.isolation.kind, "branch");
  assert.match(isolated.baselineCommit, /^[0-9a-f]{40}$/);

  await writeFile(join(checkout, "tracked.txt"), "changed\n");
  await writeFile(join(checkout, "new.txt"), "new\n");
  assert.deepEqual(await inspector.observeChanges(isolated, 5_000), ["new.txt", "tracked.txt"]);
  await assert.rejects(inspector.verify(checkout, 5_000), /contains unaccepted changes/);
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

test("test Codex adapter satisfies the effectful Worker harness contract", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-test-effectful-contract-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await exerciseEffectfulHarnessContract(new FakeCodexHarness(), checkout);
});

test("production Codex adapter satisfies the effectful Worker harness contract", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-production-effectful-contract-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await exerciseEffectfulHarnessContract(
    createCodexWorkerHarness({
      executable: process.execPath,
      args: [fakeCodexAppServer],
      version: "codex-cli 0.147.0",
    }),
    checkout,
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

class FakeLimitedNativeHarness implements NativeWorkerHarness {
  readonly selection: WorkerNativeHarnessSelection;
  readonly supportsEffectful = false;
  readonly execution;

  constructor(input: ({
    provider: "anthropic";
    nativeHarness: "claude";
  } | {
    provider: "github";
    nativeHarness: "copilot";
  }) & {
    nativeQuestions: boolean;
    cancellation: boolean;
    providerSessionResume: "conversation-replay-only";
  }) {
    this.selection = input.nativeHarness === "claude"
      ? { provider: "anthropic", nativeHarness: "claude" }
      : { provider: "github", nativeHarness: "copilot" };
    this.execution = new FakeLimitedNativeExecution(input);
  }

  async start(
    _request: WorkerStartRequest,
    observer: WorkerExecutionObserver,
  ): Promise<NativeWorkerExecution> {
    this.execution.observer = observer;
    observer.processStarted({
      process: this.execution.identity.process,
      harnessVersion: this.execution.identity.harnessVersion,
      protocolSchemaSha256: this.execution.identity.protocolSchemaSha256,
    });
    return this.execution;
  }

  async abandon(): Promise<{ gone: boolean }> {
    return { gone: true };
  }
}

class FakeLimitedNativeExecution implements NativeWorkerExecution {
  readonly identity;
  observer: WorkerExecutionObserver | undefined;
  interrupts = 0;

  constructor(input: {
    nativeHarness: "claude" | "copilot";
    nativeQuestions: boolean;
    cancellation: boolean;
    providerSessionResume: "conversation-replay-only";
  }) {
    this.identity = {
      providerSessionId: `${input.nativeHarness}-session-1`,
      nativeExecutionId: `${input.nativeHarness}-execution-1`,
      process: { pid: input.nativeHarness === "claude" ? 4201 : 4202, startedAt: "2026-08-19T10:00:00.000Z" },
      harnessVersion: `${input.nativeHarness}-version`,
      protocolSchemaSha256: `${input.nativeHarness}-schema`,
      capabilities: {
        readOnly: true as const,
        nativeQuestions: input.nativeQuestions,
        cancellation: input.cancellation,
        providerSessionResume: input.providerSessionResume,
        providerSessionDeletion: false as const,
        nativeChildControl: false as const,
        exactExecutionResume: "live-connection-only" as const,
        protocolSchemaSha256: `${input.nativeHarness}-schema`,
      },
    };
  }

  async answer(): Promise<void> {
    throw new Error("Native questions are unavailable.");
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async terminate(): Promise<{ gone: boolean }> {
    return { gone: true };
  }
}

class FakeCodexHarness implements CodexWorkerHarness {
  readonly selection = { provider: "openai", nativeHarness: "codex" } as const;
  readonly supportsEffectful = true;
  readonly starts: Array<{
    request: WorkerStartRequest;
    observer: WorkerExecutionObserver;
    execution: FakeCodexExecution;
  }> = [];
  readonly abandoned: Array<{ pid: number; startedAt: string }> = [];
  private startGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  private effectDispatchGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  private startsToFail = 0;

  async start(
    request: WorkerStartRequest,
    observer: WorkerExecutionObserver,
  ): Promise<CodexWorkerExecution> {
    const execution = new FakeCodexExecution(observer, this.starts.length + 1, !request.readOnly);
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
    if (!request.readOnly) {
      await this.effectDispatchGate?.promise;
      await observer.effectDispatchStarted?.();
    }
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

  pauseEffectDispatch(): void {
    this.effectDispatchGate = Promise.withResolvers<void>();
  }

  releaseEffectDispatch(): void {
    this.effectDispatchGate?.resolve();
    this.effectDispatchGate = undefined;
  }
}

async function exerciseEffectfulHarnessContract(
  harness: CodexWorkerHarness,
  checkout: string,
): Promise<void> {
  let effectDispatches = 0;
  const execution = await harness.start(
    {
      workerSessionId: "worker-session-effectful-contract",
      executionAttemptId: "execution-attempt-effectful-contract",
      objective: "Implement one bounded change",
      prompt: "Change src/index.ts.",
      targetProjectPath: checkout,
      model: "gpt-5.6-sol",
      readOnly: false,
      targets: ["src/index.ts"],
      authorizedWriteRoot: checkout,
      timeoutMs: 120_000,
      recoveryConstraint: "reconcile-before-replay",
    },
    {
      processStarted() {},
      effectDispatchStarted() {
        effectDispatches += 1;
      },
      question() {},
      output() {},
      completed() {},
      failed(error) {
        throw error;
      },
    },
  );
  assert.equal(effectDispatches, 1);
  assert.equal(execution.identity.writeIsolation, "codex-windows-workspace-write");
  assert.equal((await execution.terminate()).gone, true);
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

  constructor(observer: WorkerExecutionObserver, sequence: number, effectful = false) {
    this.observer = observer;
    this.identity = {
      providerSessionId: `codex-thread-${sequence}`,
      nativeExecutionId: `codex-turn-${sequence}`,
      process: { pid: 4099 + sequence, startedAt: "2026-08-19T10:00:00.000Z" },
      harnessVersion: "codex-cli 0.147.0",
      protocolSchemaSha256: codexSchemaSha256,
      capabilities: {
        readOnly: !effectful,
        nativeQuestions: true,
        cancellation: true,
        providerSessionResume: "unavailable" as const,
        providerSessionDeletion: false,
        nativeChildControl: false,
        exactExecutionResume: "live-connection-only" as const,
        protocolSchemaSha256: codexSchemaSha256,
        ...(effectful
          ? { writeIsolation: "authorized-write-root-enforced" as const }
          : {}),
      },
      ...(effectful
        ? { writeIsolation: "codex-windows-workspace-write" as const }
        : {}),
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

function declaredPlatform(): "windows" | "linux" | "darwin" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

function effectfulCheckoutInspector(
  root: string,
  observedChanges = ["src/index.ts"],
): EffectfulCheckoutInspector {
  return {
    async verify() {
      return {
        root,
        baselineCommit: "a".repeat(40),
        isolation: { kind: "branch", branch: "feat/test" },
      };
    },
    async observeChanges() {
      return observedChanges;
    },
  };
}

async function execGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true, "timed out waiting for Codex adapter event");
}
