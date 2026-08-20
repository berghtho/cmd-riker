import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { PiAgentTurnAdapter } from "../src/conversation-runtime/index.ts";
import { createLeadAgentRuntime } from "../src/lead-agent-runtime/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";
import {
  createTargetProjectOperations,
  NativeTaskCli,
} from "../src/target-project-operations/index.ts";
import {
  createCodexWorkerHarness,
  createWorkerSupervisor,
  resolveCodexRuntime,
} from "../src/worker-supervisor/index.ts";
import { startLocalModel } from "./support/local-model.ts";

const execFileAsync = promisify(execFile);
const fakeCodexAppServer = new URL("./support/fake-codex-app-server.ts", import.meta.url)
  .pathname.slice(1);
const fakeTaskCli = new URL("./support/fake-task-cli.ts", import.meta.url).pathname.slice(1);

test("installed Lead runtime completes one real Target Project Commitment through recovery and restart", async (t) => {
  const liveNativeWorker = process.env.CMD_RIKER_LIVE_V1 === "1";
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-v1-proof-"));
  const stateDirectory = join(root, "state");
  const checkoutPath = join(root, "target-project");
  const releasePath = join(root, "release-worker");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => writeFile(releasePath, "release\n").catch(() => undefined));
  await execGit(root, ["init", "-b", "main", checkoutPath]);
  const checkout = await realpath(checkoutPath);
  await execGit(checkout, ["config", "user.name", "CMD Riker V1 Proof"]);
  await execGit(checkout, ["config", "user.email", "cmd-riker@example.invalid"]);
  await writeFile(
    join(checkout, "Taskfile.yml"),
    "version: '3'\ntasks:\n  test:\n    cmds:\n      - node --test index.test.mjs\n",
  );
  await writeFile(
    join(checkout, "index.test.mjs"),
    "import assert from 'node:assert/strict';\n" +
      "import test from 'node:test';\n" +
      "import { answer } from './src/index.ts';\n" +
      "test('the implemented answer is available', () => assert.equal(answer, 42));\n",
  );
  await writeFile(
    join(checkout, "cmd-riker.operations.json"),
    JSON.stringify({
      version: 1,
      operations: {
        test: { task: "test", platforms: [declaredPlatform()], artifacts: [] },
      },
    }),
  );
  await execGit(checkout, [
    "add",
    "Taskfile.yml",
    "cmd-riker.operations.json",
    "index.test.mjs",
  ]);
  await execGit(checkout, ["commit", "-m", "test: establish target project contract"]);
  await execGit(checkout, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await execGit(checkout, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  await execGit(checkout, ["switch", "-c", "feat/v1-proof"]);

  let commitmentId = "";
  let failedWorkerSessionId = "";
  let modelCall = 0;
  const localModel = await startLocalModel((_call, requestBody) => {
    modelCall += 1;
    if (modelCall === 1) {
      return {
        toolCall: {
          id: "record-v1-commitment",
          name: "record_commitment",
          arguments: {
            outcome: "The bounded Target Project change passes its declared tests.",
            criteria: [{
              kind: "target-project-operation",
              description: "The declared Target Project tests pass.",
              operation: "test",
            }],
          },
        },
      };
    }
    if (modelCall === 2) {
      commitmentId = JSON.stringify(requestBody).match(/[0-9a-f-]{36}/)?.[0] ?? "";
      assert.match(commitmentId, /^[0-9a-f-]{36}$/);
      return effectfulDelegation(
        "delegate-v1-unready",
        commitmentId,
        "Initial hypothesis: implement after the current isolation readiness probe.",
      );
    }
    if (modelCall === 3) return "The first bounded Worker Session has started.";
    if (modelCall === 4) {
      assert.match(JSON.stringify(requestBody), new RegExp(commitmentId));
      return effectfulDelegation(
        "delegate-v1-recovered",
        commitmentId,
        "Changed hypothesis: isolation is now proven. Create only src/index.ts with exactly " +
          "`export const answer = 42;` followed by one newline.",
        {
          recoveryOfWorkerSessionId: failedWorkerSessionId,
          recoveryReason: "Isolation readiness is now proven before effect dispatch.",
        },
      );
    }
    if (modelCall === 5) return "The recovery Worker Session has started.";
    if (modelCall === 6) return "I remain available while implementation continues.";
    if (modelCall === 7) return "The accepted outcome is ready to report.";
    return "No additional outcome is pending.";
  });
  t.after(() => localModel.close());

  let state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: checkout },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: localModel.baseUrl,
    },
    modelPolicyRevision: "owner-policy-1",
    workerModelPolicy: {
      revision: "worker-policy-1",
      selection: { provider: "openai", model: "gpt-5.6-sol", nativeHarness: "codex" },
    },
  });
  const operations = createTargetProjectOperations(
    state,
    new NativeTaskCli(process.execPath, [fakeTaskCli]),
  );
  const unavailableSupervisor = createWorkerSupervisor(
    state,
    createCodexWorkerHarness({
      executable: process.execPath,
      args: [fakeCodexAppServer, "notConfigured"],
      version: "codex-cli 0.147.0",
    }),
    operations,
  );
  const adapter = new PiAgentTurnAdapter();
  const firstResponse = await createLeadAgentRuntime({
    state,
    adapter,
    workerSupervisor: unavailableSupervisor,
    targetProjectOperations: operations,
  }).completeOwnerTurn("Implement the small requested Target Project change and verify it.");
  assert.match(firstResponse, /first bounded Worker Session has started/);
  await waitFor(() => state.readWorkerSessions()[0]?.state === "failed");
  const failedWorker = state.readWorkerSessions()[0]!;
  failedWorkerSessionId = failedWorker.id;
  const failedAttempt = state.readWorkerExecutionAttempt(failedWorker.currentExecutionAttemptId)!;
  assert.equal(state.readEffectIntent(failedAttempt.effectIntentId!)?.status, "rejected");
  assert.equal(state.readCommitment(commitmentId)?.state, "active");
  await assert.rejects(readFile(join(checkout, "src", "index.ts")), /ENOENT/);

  const recoveredHarness = createCodexWorkerHarness(liveNativeWorker
    ? await resolveCodexRuntime()
    : {
        executable: process.execPath,
        args: [fakeCodexAppServer, "ready", "wait-and-write", releasePath],
        version: "codex-cli 0.147.0",
      });
  const recoveredSupervisor = createWorkerSupervisor(
    state,
    recoveredHarness,
    operations,
  );
  const runtime = createLeadAgentRuntime({
    state,
    adapter,
    workerSupervisor: recoveredSupervisor,
    targetProjectOperations: operations,
  });
  const recoveryResponse = await runtime.completeOwnerTurn(
    "Recover from the harmless isolation failure with a changed hypothesis.",
  );
  assert.match(recoveryResponse, /recovery Worker Session has started/);
  await waitFor(() => state.readWorkerSessions()[1]?.state === "running");

  const concurrentResponse = await runtime.completeOwnerTurn(
    "Stay conversational while that Worker implements the change.",
  );
  assert.match(concurrentResponse, /remain available while implementation continues/);
  assert.equal(state.readWorkerSessions()[1]?.state, "running");
  if (!liveNativeWorker) await writeFile(releasePath, "release\n");
  await waitFor(
    () =>
      state.readCommitment(commitmentId)?.state === "accepted" ||
      ["blocked", "failed", "cancelled"].includes(state.readWorkerSessions()[1]?.state ?? ""),
    liveNativeWorker ? 180_000 : 15_000,
  );
  const accepted = state.readCommitment(commitmentId)!;
  assert.equal(
    accepted.state,
    "accepted",
    JSON.stringify({ commitment: accepted, worker: state.readWorkerSessions()[1] }),
  );
  assert.equal(accepted.acceptance?.authority, "lead-agent");
  assert.equal(accepted.verification?.passed, true);
  assert.notEqual(
    state.readWorkerSessions()[0]?.assignment.prompt,
    state.readWorkerSessions()[1]?.assignment.prompt,
  );
  assert.deepEqual(state.readWorkerSessions()[1]?.assignment.coordination, {
    role: "implementer",
    recoveryOfWorkerSessionId: failedWorkerSessionId,
    recoveryReason: "Isolation readiness is now proven before effect dispatch.",
  });
  assert.equal(await readFile(join(checkout, "src", "index.ts"), "utf8"), "export const answer = 42;\n");
  const workerCount = state.readWorkerSessions().length;
  state.close();

  state = openAuthoritativeState(stateDirectory);
  const restartedOperations = createTargetProjectOperations(
    state,
    new NativeTaskCli(process.execPath, [fakeTaskCli]),
  );
  const restartedSupervisor = createWorkerSupervisor(
    state,
    createCodexWorkerHarness({
      executable: process.execPath,
      args: [fakeCodexAppServer],
      version: "codex-cli 0.147.0",
    }),
    restartedOperations,
  );
  await restartedSupervisor.recover();
  assert.equal(state.readWorkerSessions().length, workerCount);
  assert.equal(state.readCommitment(commitmentId)?.state, "accepted");
  const delivered = await createLeadAgentRuntime({
    state,
    adapter,
    workerSupervisor: restartedSupervisor,
    targetProjectOperations: restartedOperations,
  }).completeOwnerTurn("Report the accepted outcome after restart.");
  assert.match(delivered, new RegExp(`Commitment ${commitmentId} accepted by Lead Agent`));
  assert.match(delivered, /Verification attempt [0-9a-f-]{36} passed/);
  assert.match(delivered, /Residual uncertainty: none\./);
  state.close();

  state = openAuthoritativeState(stateDirectory);
  const finalResponse = await createLeadAgentRuntime({
    state,
    adapter,
  }).completeOwnerTurn("Confirm there is no duplicate outcome report.");
  assert.doesNotMatch(finalResponse, new RegExp(commitmentId));
  assert.equal(state.readCommitment(commitmentId)?.state, "accepted");
  state.close();
});

function effectfulDelegation(
  id: string,
  commitmentId: string,
  prompt: string,
  recovery?: { recoveryOfWorkerSessionId: string; recoveryReason: string },
): {
  toolCall: { id: string; name: string; arguments: Record<string, unknown> };
} {
  return {
    toolCall: {
      id,
      name: "delegate_effectful_codex",
      arguments: {
        objective: "Implement the bounded Target Project change.",
        prompt,
        commitmentId,
        targets: ["src/index.ts"],
        ...recovery,
      },
    },
  };
}

async function execGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for V1 proof state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function declaredPlatform(): "windows" | "linux" | "darwin" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}
