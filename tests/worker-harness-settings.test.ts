import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import type { WorkerSupervisor } from "../src/worker-supervisor/index.ts";

function ownerConfiguration() {
  return {
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai" as const,
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
    workerModelPolicy: {
      revision: "worker-policy-1",
      selection: {
        provider: "openai" as const,
        model: "gpt-5.6-sol",
        nativeHarness: "codex" as const,
      },
    },
  };
}

function stubSupervisor(delegations: Array<{ model: string }>): WorkerSupervisor {
  return {
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
      delegations.push({ model: input.model });
      return { workerSessionId: "worker-1", executionAttemptId: "attempt-1" };
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
}

test("Owner harness preferences persist conversationally and survive reopen", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-harness-settings-state-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const orchestration = createOrchestrationCore(state);
  const staleTurnId = state.appendOwnerMessage("Earlier turn.");
  state.appendLeadAgentMessage(staleTurnId, "Answered.");
  assert.throws(
    () => orchestration.configureWorkerHarness(staleTurnId, { harness: "codex", enabled: false }),
    /current unanswered Owner turn/i,
  );

  const turnId = state.appendOwnerMessage("Schalte Codex ab und nutze Claude mit Modell claude-opus-5.");
  const disabled = orchestration.configureWorkerHarness(turnId, { harness: "codex", enabled: false });
  assert.deepEqual(disabled, { harness: "codex", enabled: false });
  const claude = orchestration.configureWorkerHarness(turnId, {
    harness: "claude",
    enabled: true,
    model: "claude-opus-5",
  });
  assert.deepEqual(claude, { harness: "claude", enabled: true, model: "claude-opus-5" });
  state.close();

  state = openAuthoritativeState(stateDirectory);
  const settings = state.readOwnerConversation()?.workerHarnessSettings;
  assert.deepEqual(settings, {
    codex: { enabled: false },
    claude: { enabled: true, model: "claude-opus-5" },
  });
  assert.equal(state.readOwnerConversation()?.workerModelPolicy?.revision, "worker-policy-1");
  state.close();
});

test("a harness model override reaches delegation and a disabled harness stops it", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-harness-model-state-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());
  const setupTurnId = state.appendOwnerMessage("Setze das Codex-Modell auf gpt-6-pro.");
  createOrchestrationCore(state).configureWorkerHarness(setupTurnId, {
    harness: "codex",
    model: "gpt-6-pro",
  });

  const delegations: Array<{ model: string }> = [];
  class DelegatingAdapter extends DeterministicTurnAdapter {
    override async completeTurn(request: PiTurnRequest): Promise<{ content: string }> {
      if (request.workerActions?.harnesses[0]?.delegateEffectful) {
        await request.workerActions.harnesses[0]!.delegateEffectful!({
          objective: "Apply the change.",
          prompt: "Do it.",
          targets: ["src/app.ts"],
        });
        return { content: "Delegated." };
      }
      return {
        content: `No delegation available: ${request.workerUnavailability?.detail ?? "unknown"}`,
      };
    }
  }
  const runtime = () =>
    createLeadAgentRuntime({
      state,
      adapter: new DelegatingAdapter(),
      workerSupervisor: stubSupervisor(delegations),
    });

  await runtime().completeOwnerTurn("starte");
  assert.deepEqual(delegations, [{ model: "gpt-6-pro" }]);

  const disableTurn = state.appendOwnerMessage("Codex bitte deaktivieren.");
  createOrchestrationCore(state).configureWorkerHarness(disableTurn, {
    harness: "codex",
    enabled: false,
  });
  state.appendLeadAgentMessage(disableTurn, "Codex ist deaktiviert.");
  const response = await runtime().completeOwnerTurn("starte nochmal");
  assert.match(response, /No enabled harness/i);
  assert.equal(delegations.length, 1);
  state.close();
});
