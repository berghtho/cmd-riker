import assert from "node:assert/strict";
import test from "node:test";

import {
  DeterministicTurnAdapter,
  PiAgentTurnAdapter,
  type PiTurnAdapter,
} from "../src/conversation-runtime/index.ts";
import type { ModelSelection } from "../src/authoritative-state/index.ts";
import { startLocalModel } from "./support/local-model.ts";

async function exerciseContract(
  adapter: PiTurnAdapter,
  expected: string,
  selection: ModelSelection,
) {
  const result = await adapter.completeTurn({
    conversation: [
      {
        sequence: 1,
        role: "owner",
        content: "My project is durable.",
        turnId: "turn-1",
        modelSelection: selection,
        modelPolicyRevision: "owner-policy-1",
        nativeHarness: null,
      },
      {
        sequence: 2,
        role: "lead-agent",
        content: "Understood.",
        turnId: "turn-1",
        modelSelection: selection,
        modelPolicyRevision: "owner-policy-1",
        nativeHarness: null,
      },
    ],
    ownerInput: "What did I say?",
    modelSelection: selection,
  });
  assert.deepEqual(result, { content: expected });
}

test("deterministic adapter satisfies the Pi turn contract", async () => {
  await exerciseContract(
    new DeterministicTurnAdapter("Deterministic response."),
    "Deterministic response.",
    modelSelection("http://127.0.0.1:1/v1"),
  );
});

test("production adapter completes a turn through pinned pi-agent-core", async (t) => {
  const localModel = await startLocalModel(() => "Pinned Pi response.");
  t.after(() => localModel.close());

  await exerciseContract(
    new PiAgentTurnAdapter(),
    "Pinned Pi response.",
    modelSelection(localModel.baseUrl),
  );
});

test("production validation reports a failed context hard gate", async (t) => {
  const localModel = await startLocalModel(() => "Unused response.");
  t.after(() => localModel.close());
  const selection = modelSelection(localModel.baseUrl);

  const validation = await new PiAgentTurnAdapter().validateSelection(selection, {
    requiredCapabilities: ["text"],
    minimumContextWindow: 65_536,
    dataHandling: "loopback-only",
    maximumInputCostPerMillionUsd: 0,
  });

  assert.equal(validation.availability, "passed");
  assert.equal(validation.hardGates.context, "failed");
});

test("production adapter refuses a Model URL that can carry secrets", async () => {
  await assert.rejects(
    () =>
      new PiAgentTurnAdapter().completeTurn({
        conversation: [],
        ownerInput: "Do not transmit this.",
        modelSelection: modelSelection("http://127.0.0.1:11434/v1?api_key=secret"),
      }),
    /must not contain credentials, query parameters, or fragments/,
  );
});

test("production adapter advertises only the proven read-only Codex Worker controls", async (t) => {
  let delegated: unknown;
  const localModel = await startLocalModel((call, requestBody) => {
    if (call === 1) {
      const serialized = JSON.stringify(requestBody);
      assert.match(serialized, /delegate_read_only_codex/);
      assert.match(serialized, /answer_worker_question/);
      assert.match(serialized, /cancel_worker_session/);
      assert.doesNotMatch(serialized, /delegate_write|resume_worker/);
      return {
        toolCall: {
          id: "worker-call-1",
          name: "delegate_read_only_codex",
          arguments: {
            objective: "Inspect architecture",
            prompt: "Report the module seams.",
          },
        },
      };
    }
    return "The read-only Codex Worker Session is running.";
  });
  t.after(() => localModel.close());

  const result = await new PiAgentTurnAdapter().completeTurn({
    conversation: [],
    ownerInput: "Delegate a read-only architecture inspection.",
    modelSelection: modelSelection(localModel.baseUrl),
    workerActions: {
      async delegate(input) {
        delegated = input;
        return { workerSessionId: "worker-1", executionAttemptId: "attempt-1" };
      },
      async answer() {},
      async cancel() {},
    },
  });

  assert.deepEqual(delegated, {
    objective: "Inspect architecture",
    prompt: "Report the module seams.",
  });
  assert.equal(result.content, "The read-only Codex Worker Session is running.");
});

function modelSelection(baseUrl: string): ModelSelection {
  return {
    provider: "local-openai",
    model: "owner-model",
    api: "openai-completions",
    baseUrl,
  };
}
