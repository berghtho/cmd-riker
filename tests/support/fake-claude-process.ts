import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

if (
  args[0] !== "-p" ||
  flagValue("--input-format") !== "stream-json" ||
  flagValue("--output-format") !== "stream-json" ||
  flagValue("--permission-mode") !== "manual" ||
  flagValue("--tools") !== "Read,Glob,Grep" ||
  !args.includes("--safe-mode") ||
  !args.includes("--no-session-persistence") ||
  args.includes("--dangerously-skip-permissions")
) {
  process.stderr.write(`unsafe Claude arguments: ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const write = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (message.type === "control_request") {
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { still_queued: [], cancelled: [] },
      },
    });
    write({
      type: "result",
      subtype: "error_during_execution",
      terminal_reason: "aborted_streaming",
      is_error: true,
      result: "interrupted",
      session_id: "claude-session-1",
    });
    return;
  }
  if (message.type !== "user") return;
  write({
    type: "system",
    subtype: "init",
    session_id: "claude-session-1",
    claude_code_version: "2.1.229",
    model: flagValue("--model"),
    permissionMode: "manual",
    tools: ["Read", "Glob", "Grep"],
    capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"],
  });
  write({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "claude-session-1",
    result:
      'Claude read-only result.\nCMD_RIKER_OUTCOME: {"status":"completed","summary":"Claude read-only result.","affectedArtifacts":[],"verificationResults":["Architecture inspected."]}',
  });
});
