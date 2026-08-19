import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

export async function startLocalModel(
  responseForCall: (call: number, requestBody: unknown) => string,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let calls = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString("utf8");
    }
    calls += 1;
    const responseText = responseForCall(calls, JSON.parse(body));
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
