import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";
import {
  createTargetProjectOperations,
  NativeGitCheckoutInspector,
  NativeTaskCli,
  type TaskCli,
  type TargetProjectOperationEffectIntent,
  type TargetProjectOperationAttempt,
} from "../src/target-project-operations/index.ts";

test("a declared typed Target Project operation is dispatched durably and verifies its Commitment", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-operation-state-test-"));
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-target-project-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await mkdir(join(checkout, ".git"));
  const taskfile = join(checkout, "Taskfile.yml");
  await writeFile(taskfile, "version: '3'\ntasks:\n  test:\n    desc: Run tests\n    cmds: []\n");
  await writeFile(
    join(checkout, "cmd-riker.operations.json"),
    JSON.stringify({
      version: 1,
      operations: {
        test: {
          task: "test",
          platforms: [declaredPlatform()],
          artifacts: ["test-results.json"],
        },
      },
    }),
  );

  let state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: checkout },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  const orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Run the declared Target Project tests.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The declared Target Project test operation succeeds.",
    criteria: [
      {
        kind: "target-project-operation",
        description: "The declared test operation succeeds without uncertainty.",
        operation: "test",
      },
    ],
  });
  const taskCli: TaskCli = {
    async inspect() {
      return { version: "Task version: v3.53.1", taskfile, tasks: ["test"] };
    },
    async run(input) {
      assert.equal(state.readTargetProjectOperationAttempt(input.operationAttemptId)?.status, "running");
      assert.equal(state.readEffectIntent(input.effectIntentId)?.status, "dispatching");
      const currentAttempt = state.readTargetProjectOperationAttempt(input.operationAttemptId);
      assert(currentAttempt);
      assert.throws(
        () =>
          state.startTargetProjectOperation(
            {
              ...currentAttempt,
              id: "conflicting-operation-attempt",
              effectIntentId: "conflicting-effect-intent",
              status: "ready",
            },
            {
              id: "conflicting-effect-intent",
              commitmentId: currentAttempt.commitmentId,
              operationAttemptId: "conflicting-operation-attempt",
              kind: "target-project-operation",
              expectedEffect: "Conflicting test operation.",
              authorizedWriteRootKey:
                process.platform === "win32" ? checkout.toLowerCase() : checkout,
              authorization: {
                kind: "lead-agent-command-authority",
                commitmentId: currentAttempt.commitmentId,
                targetProjectPath: checkout,
                validatedAt: new Date().toISOString(),
              },
              retryRule: "Do not retry.",
              status: "pending",
            },
          ),
        /conflicting Target Project effect/,
      );
      await writeFile(join(checkout, "test-results.json"), "{\"passed\":true}\n");
      return { exitCode: 0, timedOut: false };
    },
  };

  const result = await createTargetProjectOperations(state, taskCli, {
    async verify() {
      return { root: checkout };
    },
  }).execute({
    commitmentId: commitment.id,
    operation: { kind: "test", inputs: {} },
    checkout,
    workingDirectory: checkout,
    timeoutMs: 30_000,
  });
  assert.throws(
    () =>
      orchestration.observeTargetProjectOperationResult(commitment.id, {
        ...result,
        operationAttemptId: "00000000-0000-0000-0000-000000000000",
      }),
    /current attributed durable fact/,
  );
  orchestration.observeTargetProjectOperationResult(commitment.id, result);

  assert.equal(result.status, "succeeded");
  assert.equal(result.affectedArtifacts.length, 1);
  assert.equal(result.affectedArtifacts[0]?.path, "test-results.json");
  assert.equal(result.affectedArtifacts[0]?.beforeSha256, null);
  assert.match(result.affectedArtifacts[0]?.afterSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(result.uncertainty, null);
  assert.deepEqual(result.discovery, {
    status: "verified",
    checkout: { path: checkout, status: "verified" },
    platform: { name: declaredPlatform(), status: "verified" },
    taskCli: { version: "Task version: v3.53.1", status: "verified" },
    taskfile: { path: taskfile, status: "verified" },
    operation: { semantic: "test", task: "test", status: "verified" },
  });
  const accepted = state.readCommitment(commitment.id);
  assert.equal(accepted?.state, "accepted");
  assert.equal(accepted?.verification?.passed, true);
  assert.equal(accepted?.verification?.evidence[0]?.source, "target-project-operation-result");
  assert.equal(
    accepted?.verification?.evidence[0]?.operationAttemptId,
    result.operationAttemptId,
  );
  state.close();

  state = openAuthoritativeState(stateDirectory);
  assert.equal(state.readTargetProjectOperationAttempt(result.operationAttemptId)?.status, "succeeded");
  assert.equal(state.readEffectIntent(result.effectIntentId)?.status, "succeeded");
  assert.deepEqual(
    state.readTargetProjectOperationAttempt(result.operationAttemptId)?.result,
    result,
  );
  state.close();
});

test("restart makes a dispatched Target Project operation uncertain and blocks retry", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-operation-restart-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const configuration = {
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  };
  let state = openAuthoritativeState(stateDirectory);
  state.initialize(configuration);
  let orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Run tests before restart.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The declared Target Project test operation succeeds.",
    criteria: [
      {
        kind: "target-project-operation",
        description: "The declared test operation succeeds without uncertainty.",
        operation: "test",
      },
    ],
  });
  const startedAt = "2026-08-19T10:00:00.000Z";
  const pendingAttempt: TargetProjectOperationAttempt = {
      id: "operation-attempt-1",
      commitmentId: commitment.id,
      effectIntentId: "effect-intent-1",
      operation: "test",
      checkout: configuration.targetProject.path,
      workingDirectory: configuration.targetProject.path,
      timeoutMs: 30_000,
      discovery: {
        status: "verified",
        checkout: { path: configuration.targetProject.path, status: "verified" },
        platform: { name: "windows", status: "verified" },
        taskCli: { version: "Task version: v3.53.1", status: "verified" },
        taskfile: { path: "C:\\target-project\\Taskfile.yml", status: "verified" },
        operation: { semantic: "test", task: "test", status: "verified" },
      },
      status: "ready" as const,
      startedAt,
    };
  const pendingEffect: TargetProjectOperationEffectIntent = {
      id: "effect-intent-1",
      commitmentId: commitment.id,
      operationAttemptId: "operation-attempt-1",
      kind: "target-project-operation",
      expectedEffect: "Run the declared test task.",
      authorizedWriteRootKey: configuration.targetProject.path.toLowerCase(),
      authorization: {
        kind: "lead-agent-command-authority" as const,
        commitmentId: commitment.id,
        targetProjectPath: configuration.targetProject.path,
        validatedAt: startedAt,
      },
      retryRule: "Do not retry until settled.",
      status: "pending" as const,
    };
  state.startTargetProjectOperation(pendingAttempt, pendingEffect);
  state.claimTargetProjectOperationDispatch(
    { ...pendingAttempt, status: "running" },
    {
      ...pendingEffect,
      status: "dispatching",
      lease: {
        claimedAt: startedAt,
        expiresAt: "2026-08-19T10:00:30.000Z",
      },
    },
  );
  state.close();

  state = openAuthoritativeState(stateDirectory);
  orchestration = createOrchestrationCore(state);
  orchestration.reconcileInterruptedCommitments();
  assert.equal(state.readTargetProjectOperationAttempt("operation-attempt-1")?.status, "unknown");
  assert.equal(state.readEffectIntent("effect-intent-1")?.status, "unknown");
  assert.equal(state.readCommitment(commitment.id)?.condition?.kind, "reconciling");
  assert.equal(
    state.readCommitment(commitment.id)?.verification?.evidence[0]?.source,
    "target-project-operation-result",
  );
  orchestration.observeLeadResponse(turnId, "The operation may have run.");
  assert.equal(
    state.readCommitment(commitment.id)?.verification?.evidence[0]?.source,
    "target-project-operation-result",
  );
  const resumeTurnId = state.appendOwnerMessage("Retry it.");
  assert.throws(
    () => orchestration.resumeCommitment(commitment.id, resumeTurnId),
    /uncertain effect that requires reconciliation/,
  );
  state.close();
});

test("unavailable Task discovery returns an attributed rejection without dispatch", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-operation-rejection-state-"));
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-operation-rejection-project-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await mkdir(join(checkout, ".git"));
  await writeFile(join(checkout, "Taskfile.yml"), "version: '3'\ntasks:\n  test:\n    cmds: []\n");
  await writeFile(
    join(checkout, "cmd-riker.operations.json"),
    JSON.stringify({
      version: 1,
      operations: {
        test: { task: "test", platforms: [declaredPlatform()], artifacts: [] },
      },
    }),
  );
  const state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: checkout },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  const orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Run tests if Task is available.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The declared Target Project test operation succeeds.",
    criteria: [
      {
        kind: "target-project-operation",
        description: "The declared test operation succeeds without uncertainty.",
        operation: "test",
      },
    ],
  });
  const result = await createTargetProjectOperations(
    state,
    {
      async inspect() {
        throw new Error("Task CLI is unavailable.");
      },
      async run() {
        assert.fail("Discovery rejection must not dispatch Task.");
      },
    },
    {
      async verify() {
        return { root: checkout };
      },
    },
  ).execute({
    commitmentId: commitment.id,
    operation: { kind: "test", inputs: {} },
    checkout,
    workingDirectory: checkout,
    timeoutMs: 30_000,
  });

  assert.equal(result.status, "unavailable");
  assert.equal(result.uncertainty, null);
  assert.equal(state.readTargetProjectOperationAttempt(result.operationAttemptId)?.status, "unavailable");
  assert.equal(state.readEffectIntent(result.effectIntentId)?.status, "rejected");
  orchestration.observeTargetProjectOperationResult(commitment.id, result);
  assert.equal(state.readCommitment(commitment.id)?.condition?.kind, "blocked");
  assert.equal(
    state.readCommitment(commitment.id)?.verification?.evidence[0]?.source,
    "target-project-operation-result",
  );
  state.close();
});

test("native Task adapter owns CLI arguments and excludes ambient secret variables", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-native-task-adapter-test-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const taskfile = join(checkout, "Taskfile.yml");
  const marker = join(checkout, "native-task-call.json");
  const fakeTask = join(checkout, "fake-task.mjs");
  await writeFile(taskfile, "version: '3'\ntasks:\n  test:\n    cmds: []\n");
  await writeFile(
    fakeTask,
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) console.log("Task version: v3.53.1");
else if (args.includes("--list-all")) console.log(JSON.stringify({ location: join(process.cwd(), "Taskfile.yml"), tasks: [{ name: "test" }] }));
else writeFileSync(join(process.cwd(), "native-task-call.json"), JSON.stringify({ args, secret: process.env.CMD_RIKER_TEST_SECRET ?? null }));
`,
  );
  const taskCli = new NativeTaskCli(process.execPath, [fakeTask]);
  const previousSecret = process.env.CMD_RIKER_TEST_SECRET;
  process.env.CMD_RIKER_TEST_SECRET = "must-not-cross-operation-seam";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.CMD_RIKER_TEST_SECRET;
    else process.env.CMD_RIKER_TEST_SECRET = previousSecret;
  });

  assert.deepEqual(await taskCli.inspect({ checkout, timeoutMs: 5_000 }), {
    version: "Task version: v3.53.1",
    taskfile,
    tasks: ["test"],
  });
  assert.deepEqual(
    await taskCli.run({
      operationAttemptId: "operation-attempt-1",
      effectIntentId: "effect-intent-1",
      checkout,
      workingDirectory: checkout,
      taskfile,
      task: "test",
      timeoutMs: 5_000,
    }),
    { exitCode: 0, timedOut: false, outputTail: "" },
  );
  const call = JSON.parse(await readFile(marker, "utf8")) as { args: string[]; secret: string | null };
  assert.deepEqual(call.args, [
    "--dir",
    checkout,
    "--taskfile",
    taskfile,
    "--disable-fuzzy",
    "--color=false",
    "test",
  ]);
  assert.equal(call.secret, null);
});

test(
  "native Task adapter runs npm .cmd shims through ComSpec",
  { skip: process.platform !== "win32" },
  async (t) => {
    const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-task-shim-test-"));
    t.after(() => rm(checkout, { recursive: true, force: true }));
    const taskfile = join(checkout, "Taskfile.yml");
    const fakeTask = join(checkout, "fake-task.mjs");
    await writeFile(taskfile, "version: '3'\ntasks:\n  test:\n    cmds: []\n");
    await writeFile(
      fakeTask,
      `import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--version")) console.log("Task version: v3.53.1");
else if (args.includes("--list-all")) console.log(JSON.stringify({ location: join(process.cwd(), "Taskfile.yml"), tasks: [{ name: "test" }] }));
`,
    );
    await writeFile(
      join(checkout, "fake-task.cmd"),
      `@echo off\r\n"${process.execPath}" "${fakeTask}" %*\r\n`,
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${checkout};${previousPath ?? ""}`;
    t.after(() => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    });

    assert.deepEqual(await new NativeTaskCli("fake-task").inspect({ checkout, timeoutMs: 10_000 }), {
      version: "Task version: v3.53.1",
      taskfile,
      tasks: ["test"],
    });
  },
);

test("native checkout inspector verifies the active Git root", async () => {
  const checkout = process.cwd();
  assert.deepEqual(
    await new NativeGitCheckoutInspector().verify({ checkout, timeoutMs: 5_000 }),
    { root: checkout },
  );
});

function declaredPlatform(): "windows" | "linux" | "darwin" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
