import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { PiAgentTurnAdapter, PiTurnFailure } from "../src/conversation-runtime/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";
import { startLocalModel } from "./support/local-model.ts";

for (const tool of ["bash", "read"] as const) {
  test(`native ${tool} followed by a Model failure preserves the correct fallback decision`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `cmd-riker-native-${tool}-`));
    const state = openAuthoritativeState(join(directory, "state"));
    t.after(async () => {
      state.close();
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(join(directory, "input.txt"), "Read-only evidence.\n");
    let calls = 0;
    const model = await startLocalModel((call) => {
      calls = call;
      return call === 1 ? {
        toolCall: {
          id: "native-call", name: tool,
          arguments: tool === "bash"
            ? { command: "printf 'dispatched\\n' >> dispatch.txt\nexit 7", timeout: 10 }
            : { path: "input.txt" },
        },
      } : { errorStatus: 401 };
    });
    t.after(() => model.close());
    const selection = {
      provider: "local-openai" as const, model: "owner-model",
      api: "openai-completions" as const, baseUrl: model.baseUrl,
    };
    state.initialize({ targetProject: { path: directory }, modelSelection: selection, modelPolicyRevision: "test" });
    let failure: PiTurnFailure | undefined;
    await assert.rejects(new PiAgentTurnAdapter().completeTurn({
      conversation: [], ownerInput: "Run the requested local tool.",
      modelSelection: selection, nativeTools: { cwd: directory },
    }), (error) => {
      assert.ok(error instanceof PiTurnFailure);
      failure = error;
      return true;
    });
    assert.equal(calls, 2);
    assert.ok(failure);
    assert.equal(failure.commitmentMutationApplied, tool === "bash");
    assert.equal(createOrchestrationCore(state).modelFailureDecision(failure), tool === "bash" ? "stop" : "fallback");
    if (tool === "bash") {
      assert.equal(await readFile(join(directory, "dispatch.txt"), "utf8"), "dispatched\n");
    } else {
      assert.equal(await readFile(join(directory, "input.txt"), "utf8"), "Read-only evidence.\n");
    }
  });
}
