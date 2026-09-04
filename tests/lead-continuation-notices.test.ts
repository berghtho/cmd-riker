import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { pendingLeadContinuations, type LeadContinuation } from "../src/lead-continuation/index.ts";
import { projectSessionView } from "../src/session-view/index.ts";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cmd-riker-follow-up-notices-"));
  const state = openAuthoritativeState(directory);
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const paths = { a: join(directory, "a"), b: join(directory, "b") };
  state.initialize({
    targetProject: { path: paths.a }, projects: [{ name: "B", path: paths.b }],
    modelSelection: {
      provider: "local-openai", model: "owner-model",
      api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
    },
    modelPolicyRevision: "test",
  });
  state.appendOwnerSessionSnapshots([{
    id: "b", name: "B", projectPath: paths.b, state: "active", createdAt: new Date().toISOString(),
  }]);
  const origin = state.appendOwnerMessage("Research the change.");
  state.appendLeadAgentMessage(origin, "Research is underway.");
  const continuation = (name: string) => {
    state.appendWorkerSessionSnapshots([{
      id: name, state: "completed", currentExecutionAttemptId: `${name}-attempt`,
      assignment: {
        readOnly: true, ownerTurnId: origin, targetProjectPath: paths.a,
        objective: "Research", prompt: "Investigate.", modelPolicyRevision: "test",
      },
    }]);
    state.appendWorkerExecutionAttemptSnapshots([{
      id: `${name}-attempt`, workerSessionId: name, generation: 1,
      modelSelection: { provider: "openai", nativeHarness: "codex", model: "gpt-5.6-sol" },
      modelPolicyRevision: "test", status: "completed",
    }]);
    const candidate = pendingLeadContinuations(state).find((entry) => entry.workerSessionId === name);
    assert.ok(candidate);
    const receipt = state.claimLeadContinuation(candidate);
    assert.ok(receipt);
    return receipt;
  };
  return { state, paths, continuation };
}

test("failed automatic follow-up stays visible only in its project until its Owner Session responds", async (t) => {
  const { state, paths, continuation } = await setup(t);
  const receipt = continuation("worker-a");
  state.settleLeadContinuation(receipt.id, "failed", "model-unavailable");
  const notices = () => projectSessionView(state, { targetProjectPath: paths.a }).notices;
  assert.match(notices().join("\n"), /Model is unavailable/);
  assert.deepEqual(projectSessionView(state, { targetProjectPath: paths.b }).notices, []);

  const otherTurn = state.appendOwnerMessage("How is B?", "b");
  state.appendLeadAgentMessage(otherTurn, "B is ready.");
  assert.equal(notices().length, 1);
  const ownerTurn = state.appendOwnerMessage("Continue the research.");
  assert.equal(notices().length, 1);
  state.appendLeadAgentMessage(ownerTurn, "The research can continue.");
  assert.deepEqual(notices(), []);

  const nextReceipt = continuation("worker-a-next");
  state.settleLeadContinuation(nextReceipt.id, "failed", "turn-failed");
  assert.match(notices().join("\n"), /could not complete its automatic follow-up/);
});

test("Owner interruption stays quiet; other follow-up failures expose no internal identifiers", async (t) => {
  const { state, paths, continuation } = await setup(t);
  const aborted = continuation("private-worker-id");
  state.settleLeadContinuation(aborted.id, "failed", "aborted");
  assert.deepEqual(projectSessionView(state, { targetProjectPath: paths.a }).notices, []);
  for (const [name, failureKind] of [
    ["private-lost-id", "continuity-lost"],
    ["private-failed-id", "turn-failed"],
  ] as const) {
    const receipt = continuation(name);
    state.settleLeadContinuation(receipt.id, "failed", failureKind);
  }
  const notices = projectSessionView(state, { targetProjectPath: paths.a }).notices;
  assert.equal(notices.length, 2);
  assert.match(notices.join("\n"), /Effects may already have run/);
  assert.match(notices.join("\n"), /review the current state/);
  assert.doesNotMatch(notices.join("\n"), /private-|[0-9a-f]{8}-[0-9a-f]{4}/);
});

test("a later autonomous response does not dismiss a previous failed follow-up", async (t) => {
  const { state, paths, continuation } = await setup(t);
  const failed = continuation("worker-failed");
  state.settleLeadContinuation(failed.id, "failed", "turn-failed");
  const completed: LeadContinuation = continuation("worker-completed");
  state.appendLeadContinuationMessageWithAccounts(
    completed.id, "Another Worker finished.", { selfRepairs: [], commitments: [] },
  );
  state.settleLeadContinuation(completed.id, "completed");
  assert.equal(projectSessionView(state, { targetProjectPath: paths.a }).notices.length, 1);
});
