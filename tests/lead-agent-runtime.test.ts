import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import {
  DeterministicTurnAdapter,
  type PiTurnRequest,
} from "../src/conversation-runtime/index.ts";
import { createLeadAgentRuntime } from "../src/lead-agent-runtime/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";
import {
  createTargetProjectOperations,
  type TaskCli,
} from "../src/target-project-operations/index.ts";
import type { WorkerSupervisor } from "../src/worker-supervisor/index.ts";

test("Lead runtime delivers one durable account for an asynchronously accepted Commitment after restart", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-runtime-account-state-"));
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-runtime-account-project-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await mkdir(join(checkout, ".git"));
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
  const ownerTurnId = state.appendOwnerMessage("Implement the bounded Target Project change.");
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The bounded Target Project change passes its declared tests.",
    criteria: [{
      kind: "target-project-operation",
      description: "The declared Target Project tests pass.",
      operation: "test",
    }],
  });
  const taskCli: TaskCli = {
    async inspect() {
      return { version: "Task version: v3.53.1", taskfile, tasks: ["test"] };
    },
    async run() {
      return { exitCode: 0, timedOut: false };
    },
  };
  const operation = await createTargetProjectOperations(state, taskCli, {
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
  orchestration.observeTargetProjectOperationResult(commitment.id, operation);
  assert.equal(state.readCommitment(commitment.id)?.state, "accepted");
  state.close();

  state = openAuthoritativeState(stateDirectory);
  const runtime = createLeadAgentRuntime({
    state,
    adapter: new DeterministicTurnAdapter("I remain available."),
  });
  const delivered = await runtime.completeOwnerTurn("What completed while I was away?");

  assert.match(delivered, /Delivered: The bounded Target Project change passes its declared tests\./);
  assert.match(delivered, /Verified via the declared Target Project operation\./);
  assert.match(delivered, /Residual uncertainty: none\./);
  assert.doesNotMatch(delivered, new RegExp(commitment.id));
  assert.doesNotMatch(delivered, new RegExp(operation.operationAttemptId));
  assert.equal(state.leadAgentResponse(state.latestOwnerTurnId()!), delivered);
  state.close();

  state = openAuthoritativeState(stateDirectory);
  const afterDelivery = await createLeadAgentRuntime({
    state,
    adapter: new DeterministicTurnAdapter("Still here."),
  }).completeOwnerTurn("Anything else?");
  assert.doesNotMatch(afterDelivery, new RegExp(commitment.id));
  state.close();
});

test("an effectful delegation without a Commitment records its covering Commitment automatically", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-runtime-autocommit-state-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
    workerModelPolicy: {
      revision: "worker-policy-1",
      selection: { provider: "openai", model: "gpt-5.6-sol", nativeHarness: "codex" },
    },
  });
  const delegations: Array<{ commitmentId: string }> = [];
  const workerSupervisor: WorkerSupervisor = {
    capabilities: () => ({
      nativeHarness: "codex",
      effectful: true,
      nativeQuestions: false,
      cancellation: false,
    }),
    async delegate() {
      throw new Error("Read-only delegation is not part of this test.");
    },
    async delegateEffectful(input) {
      delegations.push({ commitmentId: input.commitmentId });
      return { workerSessionId: "worker-auto", executionAttemptId: "attempt-auto" };
    },
    async delegateReview() {
      throw new Error("Review delegation is not part of this test.");
    },
    async answer() {},
    async steer() {},
    workerOutput: () => undefined,
    async cancel() {},
    async recover() {},
  };
  class DelegatingAdapter extends DeterministicTurnAdapter {
    override async completeTurn(request: PiTurnRequest): Promise<{ content: string }> {
      await request.workerActions!.harnesses[0]!.delegateEffectful!({
        objective: "Fix the reported bug in src/app.ts.",
        prompt: "Fix the bug.",
        targets: ["src/app.ts"],
      });
      return { content: "The Worker Session is underway." };
    }
  }

  await createLeadAgentRuntime({
    state,
    adapter: new DelegatingAdapter(),
    workerSupervisor,
  }).completeOwnerTurn("starte einfach");

  assert.equal(delegations.length, 1);
  const commitment = state.readCommitment(delegations[0]!.commitmentId);
  assert.equal(commitment?.state, "active");
  assert.equal(commitment?.criteria.length, 1);
  assert.equal(commitment?.criteria[0]?.kind, "target-project-operation");
  assert.equal(
    commitment?.criteria[0]?.kind === "target-project-operation"
      ? commitment.criteria[0].operation
      : undefined,
    "test",
  );
  assert.equal(commitment?.outcome, "Fix the reported bug in src/app.ts.");
  state.close();
});

function declaredPlatform(): "windows" | "linux" | "darwin" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
