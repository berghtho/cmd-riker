import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { DeterministicTurnAdapter } from "../src/conversation-runtime/index.ts";
import { createLeadAgentRuntime } from "../src/lead-agent-runtime/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";
import {
  createTargetProjectOperations,
  type TaskCli,
} from "../src/target-project-operations/index.ts";

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

  assert.match(delivered, new RegExp(`Commitment ${commitment.id} accepted by Lead Agent`));
  assert.match(delivered, new RegExp(`Verification attempt ${operation.operationAttemptId}`));
  assert.match(delivered, /Residual uncertainty: none\./);
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

function declaredPlatform(): "windows" | "linux" | "darwin" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
