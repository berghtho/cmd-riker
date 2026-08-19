import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (
  !args.includes("--acp") ||
  !args.includes("--stdio") ||
  !args.includes("--no-auto-update") ||
  !args.includes("--no-remote-export") ||
  !args.includes("--no-remote") ||
  args.includes("--allow-all") ||
  args.includes("--add-dir")
) {
  process.stderr.write(`unsafe Copilot arguments: ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const write = (value: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
  };
  if (message.method === "initialize") {
    write({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "GitHub Copilot CLI", version: "1.0.80" },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { close: true },
        },
      },
    });
    return;
  }
  if (message.method === "session/new") {
    write({ id: message.id, result: { sessionId: "copilot-session-1", configOptions: [] } });
    return;
  }
  if (message.method === "session/prompt") {
    write({
      method: "session/update",
      params: {
        sessionId: "copilot-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              'Copilot read-only result.\nCMD_RIKER_OUTCOME: {"status":"completed","summary":"Copilot read-only result.","affectedArtifacts":[],"verificationResults":["Architecture inspected."]}',
          },
        },
      },
    });
    write({ id: message.id, result: { stopReason: "end_turn", usage: null } });
    return;
  }
  if (message.method === "session/close") {
    write({ id: message.id, result: {} });
    return;
  }
  if (message.id !== undefined) {
    write({ id: message.id, error: { code: -32601, message: "unsupported" } });
  }
});
