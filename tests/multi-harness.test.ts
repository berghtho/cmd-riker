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

function stubSupervisor(
  nativeHarness: "codex" | "claude",
  delegations: Array<{ harness: string; model: string; kind: "read-only" | "effectful" }>,
): WorkerSupervisor {
  return {
    capabilities: () => ({
      nativeHarness,
      effectful: true,
      nativeQuestions: false,
      cancellation: true,
    }),
    async delegate(input) {
      delegations.push({ harness: nativeHarness, model: input.model, kind: "read-only" });
      return {
        workerSessionId: `worker-${nativeHarness}-read`,
        executionAttemptId: `attempt-${nativeHarness}-read`,
      };
    },
    async delegateEffectful(input) {
      delegations.push({ harness: nativeHarness, model: input.model, kind: "effectful" });
      return {
        workerSessionId: `worker-${nativeHarness}`,
        executionAttemptId: `attempt-${nativeHarness}`,
      };
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

test("the Lead delegates per task across two effectful harnesses in one turn", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-multi-harness-state-"));
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
  const setupTurnId = state.appendOwnerMessage("Aktiviere Claude mit Modell claude-opus-5.");
  createOrchestrationCore(state).configureWorkerHarness(setupTurnId, {
    harness: "claude",
    enabled: true,
    model: "claude-opus-5",
  });

  const delegations: Array<{ harness: string; model: string; kind: "read-only" | "effectful" }> = [];
  class FanOutAdapter extends DeterministicTurnAdapter {
    override async completeTurn(request: PiTurnRequest): Promise<{ content: string }> {
      const roster = request.workerActions!.harnesses;
      assert.deepEqual(
        roster.map((harness) => harness.nativeHarness).sort(),
        ["claude", "codex"],
      );
      const codex = roster.find((harness) => harness.nativeHarness === "codex")!;
      const claude = roster.find((harness) => harness.nativeHarness === "claude")!;
      await codex.delegateEffectful!({
        objective: "Implement the CSV export.",
        prompt: "Implement it.",
        targets: ["src/export.ts"],
      });
      await claude.delegate({
        objective: "Review the CSV export approach.",
        prompt: "Review it.",
      });
      await assert.rejects(
        request.workerActions!.steer!("unknown-worker", "hello"),
        /unknown or outside the active Target Project/i,
      );
      return { content: "Both Workers are underway." };
    }
  }

  await createLeadAgentRuntime({
    state,
    adapter: new FanOutAdapter(),
    workerSupervisors: {
      codex: stubSupervisor("codex", delegations),
      claude: stubSupervisor("claude", delegations),
    },
  }).completeOwnerTurn("Baue den CSV-Export.");

  assert.deepEqual(delegations, [
    { harness: "codex", model: "gpt-5.6-sol", kind: "effectful" },
    { harness: "claude", model: "claude-opus-5", kind: "read-only" },
  ]);
  assert.equal(state.readCommitments().length, 1);
  state.close();
});
