import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";

import {
  DeterministicTurnAdapter,
  PiAgentTurnAdapter,
  type PiTurnAdapter,
} from "../src/conversation-runtime/index.ts";
import type { ModelSelection } from "../src/authoritative-state/index.ts";

async function exerciseContract(
  adapter: PiTurnAdapter,
  expected: string,
  selection: ModelSelection,
) {
  const result = await adapter.completeTurn({
    conversation: [
      { sequence: 1, role: "owner", content: "My project is durable." },
      {
        sequence: 2,
        role: "lead-agent",
        content: "Understood.",
        modelSelection: selection,
        modelPolicyRevision: "owner-policy-1",
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
  const localModel = await startLocalModel("Pinned Pi response.");
  t.after(() => close(localModel.server));

  await exerciseContract(
    new PiAgentTurnAdapter(),
    "Pinned Pi response.",
    modelSelection(localModel.baseUrl),
  );
});

async function startLocalModel(
  responseText: string,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before returning the deterministic local model response.
    }
    const chunk = (delta: object, finishReason: string | null = null) => ({
      id: "cmd-riker-contract",
      object: "chat.completion.chunk",
      created: 1,
      model: "owner-model",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      connection: "close",
    });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({ content: responseText }))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function modelSelection(baseUrl: string): ModelSelection {
  return {
    provider: "local-openai",
    model: "owner-model",
    api: "openai-completions",
    baseUrl,
  };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
