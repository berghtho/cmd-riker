import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

export async function startLocalModel(
  responseForCall: (call: number, requestBody: unknown) =>
    | string
    | {
        toolCall: { id: string; name: string; arguments: object };
      }
    | { errorStatus: number },
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let calls = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: [
            {
              id: "owner-model",
              capabilities: ["text"],
              context_window: 32_768,
              input_cost_per_million_usd: 0,
            },
          ],
        }),
      );
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString("utf8");
    }
    calls += 1;
    const modelResponse = responseForCall(calls, JSON.parse(body));
    if (typeof modelResponse !== "string" && "errorStatus" in modelResponse) {
      response.writeHead(modelResponse.errorStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Induced Model failure." } }));
      return;
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
    if (typeof modelResponse === "string") {
      response.write(`data: ${JSON.stringify(chunk({ content: modelResponse }))}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    } else {
      const { toolCall } = modelResponse;
      response.write(
        `data: ${JSON.stringify(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: toolCall.id,
                type: "function",
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.arguments),
                },
              },
            ],
          }),
        )}\n\n`,
      );
      response.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => close(server),
  };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
