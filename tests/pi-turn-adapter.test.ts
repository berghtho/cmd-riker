import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("production adapter grants the Lead its full native tool belt", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "cmd-riker-native-tools-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let firstRequest = "";
  const localModel = await startLocalModel((_call, requestBody) => {
    firstRequest ||= JSON.stringify(requestBody);
    return "Acting directly.";
  });
  t.after(() => localModel.close());

  await new PiAgentTurnAdapter().completeTurn({
    conversation: [],
    ownerInput: "starte einfach",
    modelSelection: modelSelection(localModel.baseUrl),
    nativeTools: { cwd },
  });

  assert.match(firstRequest, /full native tool belt/);
  for (const toolName of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
    assert.match(firstRequest, new RegExp(`"name"\\s*:\\s*"${toolName}"`));
  }
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

test("production adapter advertises the bounded Codex Worker controls", async (t) => {
  let delegated: unknown;
  const localModel = await startLocalModel((call, requestBody) => {
    if (call === 1) {
      const serialized = JSON.stringify(requestBody);
      assert.match(serialized, /delegate_read_only_codex/);
      assert.match(serialized, /delegate_effectful_codex/);
      assert.match(serialized, /answer_worker_question/);
      assert.match(serialized, /reserve_worker_question_for_owner/);
      assert.match(serialized, /recoveryOfWorkerSessionId/);
      assert.match(serialized, /cancel_worker_session/);
      assert.doesNotMatch(serialized, /resume_worker/);
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
      async delegateEffectful() {
        return { workerSessionId: "worker-effectful-1", executionAttemptId: "attempt-effectful-1" };
      },
      async answer() {},
      reserveOwnerDecision() {},
      async cancel() {},
    },
  });

  assert.deepEqual(delegated, {
    objective: "Inspect architecture",
    prompt: "Report the module seams.",
  });
  assert.equal(result.content, "The read-only Codex Worker Session is running.");
});

test("production adapter exposes only proven Copilot Worker controls", async (t) => {
  const localModel = await startLocalModel((call, requestBody) => {
    if (call === 1) {
      const serialized = JSON.stringify(requestBody);
      assert.match(serialized, /delegate_read_only_copilot/);
      assert.doesNotMatch(serialized, /delegate_effectful/);
      assert.doesNotMatch(serialized, /answer_worker_question/);
      assert.doesNotMatch(serialized, /cancel_worker_session/);
      assert.doesNotMatch(serialized, /resume_worker|delete_worker|child_worker/);
      return {
        toolCall: {
          id: "copilot-worker-call-1",
          name: "delegate_read_only_copilot",
          arguments: {
            objective: "Inspect architecture",
            prompt: "Report the module seams.",
          },
        },
      };
    }
    return "The read-only Copilot Worker Session is running.";
  });
  t.after(() => localModel.close());

  const result = await new PiAgentTurnAdapter().completeTurn({
    conversation: [],
    ownerInput: "Delegate a read-only architecture inspection.",
    modelSelection: modelSelection(localModel.baseUrl),
    workerActions: {
      capabilities: {
        nativeHarness: "copilot",
        effectful: false,
        nativeQuestions: false,
        cancellation: false,
      },
      async delegate() {
        return { workerSessionId: "worker-copilot-1", executionAttemptId: "attempt-copilot-1" };
      },
    },
  });

  assert.equal(result.content, "The read-only Copilot Worker Session is running.");
});

test("production adapter exposes explicit authority controls and independent Review", async (t) => {
  let recordedTitle: string | undefined;
  let firstRequest = "";
  const localModel = await startLocalModel((call, requestBody) => {
    if (call === 1) {
      firstRequest = JSON.stringify(requestBody);
      return {
        toolCall: {
          id: "standing-order-call-1",
          name: "record_standing_order",
          arguments: {
            title: "Integrate while absent",
            instruction: "Merge the verified Commitment.",
            commitmentIds: ["commitment-1"],
            effectClasses: ["merge"],
            targets: ["main"],
            allowIrreversibleEffects: false,
            allowExternallyBindingEffects: false,
            maximumIncrementalSpendUsd: 0,
            validUntil: "2026-08-20T10:00:00.000Z",
            ownerInstructionQuote: "Record this Standing Order.",
          },
        },
      };
    }
    return "The bounded Standing Order is recorded.";
  });
  t.after(() => localModel.close());

  const result = await new PiAgentTurnAdapter().completeTurn({
    conversation: [],
    ownerInput: "Record this Standing Order.",
    modelSelection: modelSelection(localModel.baseUrl),
    authorityActions: {
      recordStandingOrder(draft) {
        recordedTitle = draft.title;
        return {
          id: "standing-order-1",
          ...draft,
          validFrom: "2026-08-19T10:00:00.000Z",
          createdByOwnerTurnId: "owner-turn-1",
          state: "active",
        };
      },
      revokeStandingOrder() {},
      beginActingAuthority() {
        throw new Error("Not called.");
      },
      recordActingAuthorityEvent() {
        throw new Error("Not called.");
      },
      prepareActingAuthorityHandoff() {
        throw new Error("Not called.");
      },
    },
    workerActions: {
      async delegate() {
        return { workerSessionId: "worker-1", executionAttemptId: "attempt-1" };
      },
      async delegateReview() {
        return { workerSessionId: "reviewer-1", executionAttemptId: "review-attempt-1" };
      },
    },
  });

  assert.equal(recordedTitle, "Integrate while absent");
  assert.match(firstRequest, /record_standing_order/);
  assert.match(firstRequest, /begin_acting_authority/);
  assert.match(firstRequest, /record_acting_authority_event/);
  assert.match(firstRequest, /prepare_acting_authority_handoff/);
  assert.match(firstRequest, /delegate_independent_review/);
  assert.equal(result.content, "The bounded Standing Order is recorded.");
});

test("production adapter delegates effectful work only through the bounded assignment tool", async (t) => {
  let delegated: unknown;
  const localModel = await startLocalModel((call) => {
    if (call === 1) {
      return {
        toolCall: {
          id: "effectful-worker-call-1",
          name: "delegate_effectful_codex",
          arguments: {
            objective: "Implement the accepted change",
            prompt: "Change only src/index.ts.",
            commitmentId: "commitment-1",
            targets: ["src/index.ts"],
          },
        },
      };
    }
    return "The bounded implementation Worker Session is running.";
  });
  t.after(() => localModel.close());

  const result = await new PiAgentTurnAdapter().completeTurn({
    conversation: [],
    ownerInput: "Implement the accepted Target Project change.",
    modelSelection: modelSelection(localModel.baseUrl),
    workerActions: {
      async delegate() {
        return { workerSessionId: "worker-read-only", executionAttemptId: "attempt-read-only" };
      },
      async delegateEffectful(input) {
        delegated = input;
        return { workerSessionId: "worker-1", executionAttemptId: "attempt-1" };
      },
      async answer() {},
      async cancel() {},
    },
  });

  assert.deepEqual(delegated, {
    objective: "Implement the accepted change",
    prompt: "Change only src/index.ts.",
    commitmentId: "commitment-1",
    targets: ["src/index.ts"],
  });
  assert.equal(result.content, "The bounded implementation Worker Session is running.");
});

test("production adapter exposes typed Forge operations without provider commands", async (t) => {
  let executed: unknown;
  let firstRequest = "";
  const localModel = await startLocalModel((call, requestBody) => {
    if (call === 1) {
      firstRequest = JSON.stringify(requestBody);
      return {
        toolCall: {
          id: "github-comment-call-1",
          name: "comment_on_github_issue",
          arguments: {
            commitmentId: "commitment-1",
            issueNumber: 36,
            body: "Typed Forge proof.",
            actingAuthorityEffect: {
              actingAuthorityId: "acting-1",
              commitmentId: "commitment-1",
              effectClass: "update",
              target: "berghtho/cmd-riker#36",
              reversible: true,
              externallyBinding: true,
              incrementalSpendUsd: 0,
            },
          },
        },
      };
    }
    return "The typed GitHub operation is recorded.";
  });
  t.after(() => localModel.close());

  const result = await new PiAgentTurnAdapter().completeTurn({
    conversation: [],
    ownerInput: "Record the GitHub proof.",
    modelSelection: modelSelection(localModel.baseUrl),
    forgeActions: {
      async commentOnGitHubIssue(input) {
        executed = input;
        return {
          operationAttemptId: "forge-attempt-1",
          effectIntentId: "forge-effect-1",
          commitmentId: input.commitmentId,
          operation: "github-issue-comment",
          provider: "github",
          status: "succeeded",
          evidence: [{
            source: "provider-readback",
            reference: "https://github.test/comment-1",
            summary: "The comment matched its attributed read-back.",
            observedAt: "2026-08-19T20:00:00.000Z",
          }],
          diagnostics: [],
          uncertainty: null,
          startedAt: "2026-08-19T20:00:00.000Z",
          completedAt: "2026-08-19T20:00:01.000Z",
        };
      },
      async inspectAzureSubscription() {
        throw new Error("not expected");
      },
    },
  });

  assert.deepEqual(executed, {
    commitmentId: "commitment-1",
    issueNumber: 36,
    body: "Typed Forge proof.",
  });
  assert.match(firstRequest, /comment_on_github_issue/);
  assert.match(firstRequest, /inspect_azure_subscription/);
  assert.doesNotMatch(firstRequest, /gh api|az account/);
  assert.equal(result.content, "The typed GitHub operation is recorded.");
});

test("production adapter exposes only configured Forge provider tools", async (t) => {
  let request = "";
  const localModel = await startLocalModel((_call, requestBody) => {
    request = JSON.stringify(requestBody);
    return "Azure inspection is available.";
  });
  t.after(() => localModel.close());

  await new PiAgentTurnAdapter().completeTurn({
    conversation: [],
    ownerInput: "Inspect configured provider tools.",
    modelSelection: modelSelection(localModel.baseUrl),
    forgeActions: {
      async inspectAzureSubscription() {
        throw new Error("not expected");
      },
    },
  });

  assert.match(request, /inspect_azure_subscription/);
  assert.doesNotMatch(request, /comment_on_github_issue/);
});

function modelSelection(baseUrl: string): ModelSelection {
  return {
    provider: "local-openai",
    model: "owner-model",
    api: "openai-completions",
    baseUrl,
  };
}
