import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = args[0];
if (
  !args.includes("--acp") ||
  !args.includes("--stdio") ||
  !args.includes("--no-auto-update") ||
  !args.includes("--no-remote-export") ||
  !args.includes("--no-remote") ||
  !args.includes("--no-custom-instructions") ||
  !args.includes("--no-ask-user") ||
  !args.includes("--no-experimental") ||
  !args.includes("--disable-builtin-mcps") ||
  !args.includes("--disallow-temp-dir") ||
  !args.includes("--available-tools=view,grep,glob") ||
  !args.includes("--deny-tool=write") ||
  !args.includes("--deny-tool=shell") ||
  !args.includes("--deny-tool=url") ||
  args.includes("--allow-all") ||
  args.includes("--allow-all-tools") ||
  args.includes("--allow-all-paths") ||
  args.includes("--allow-all-urls") ||
  args.some((arg) => arg.startsWith("--allow-tool")) ||
  args.includes("--add-dir")
) {
  process.stderr.write(`unsafe Copilot arguments: ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const write = (value: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
};

let pendingWritePromptId: number | undefined;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line) as {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
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
    if (mode === "attempt-write") {
      pendingWritePromptId = message.id as number;
      write({
        id: "write-permission",
        method: "session/request_permission",
        params: {
          toolCall: { kind: "write" },
          options: [
            { kind: "allow_once", optionId: "allow-write" },
            { kind: "reject_once", optionId: "reject-write" },
          ],
        },
      });
      return;
    }
    if (mode === "fail-prompt") {
      process.stdout.write("not-json\n");
      setTimeout(() => process.exit(3), 10);
      return;
    }
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
  if (message.id === "write-permission" && pendingWritePromptId !== undefined) {
    const outcome = message.result?.outcome as Record<string, unknown> | undefined;
    if (outcome?.optionId !== "reject-write") {
      writeFileSync(String(args[1]), "unsafe write\n");
    }
    write({
      method: "session/update",
      params: {
        sessionId: "copilot-session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              'Copilot write denied.\nCMD_RIKER_OUTCOME: {"status":"completed","summary":"Copilot write denied.","affectedArtifacts":[],"verificationResults":["Write permission rejected."]}',
          },
        },
      },
    });
    write({ id: pendingWritePromptId, result: { stopReason: "end_turn", usage: null } });
    pendingWritePromptId = undefined;
    setTimeout(() => process.exit(0), 10);
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
