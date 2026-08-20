import { createInterface } from "node:readline";
import { mkdir, stat, writeFile } from "node:fs/promises";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;
let threadStarted = false;
let effectful = false;
let sandboxProbeCount = 0;
const sandboxReadiness = process.argv[2] ?? "ready";
const effectMode = process.argv[3] ?? "report-only";
const releasePath = process.argv[4];

for await (const line of lines) {
  const message = JSON.parse(line) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  };
  if (message.method === "initialize") {
    const capabilities = message.params?.capabilities as { experimentalApi?: boolean } | undefined;
    if (capabilities?.experimentalApi !== true) process.exit(21);
    respond(message.id!, { userAgent: "codex-cli 0.147.0" });
    continue;
  }
  if (message.method === "initialized") {
    initialized = true;
    continue;
  }
  if (message.method === "windowsSandbox/readiness") {
    respond(message.id!, { status: sandboxReadiness });
    continue;
  }
  if (message.method === "command/exec") {
    const sandboxPolicy = message.params?.sandboxPolicy as
      | {
          type?: string;
          networkAccess?: boolean;
          writableRoots?: string[];
          excludeTmpdirEnvVar?: boolean;
        }
      | undefined;
    const command = message.params?.command as string[] | undefined;
    if (
      sandboxPolicy?.type !== "workspaceWrite" ||
      sandboxPolicy.networkAccess !== false ||
      sandboxPolicy.excludeTmpdirEnvVar !== true ||
      sandboxPolicy.writableRoots?.length !== 0 ||
      !command?.at(-1)
    ) {
      process.exit(26);
    }
    if (sandboxProbeCount++ === 0) {
      await writeFile(command.at(-1)!, "cmd-riker-isolation-probe");
      respond(message.id!, { exitCode: 0, stdout: "", stderr: "" });
    } else {
      respond(message.id!, { exitCode: 1, stdout: "", stderr: "access denied" });
    }
    continue;
  }
  if (message.method === "thread/start") {
    effectful = message.params?.sandbox === "workspace-write";
    if (
      !initialized ||
      message.params?.approvalPolicy !== "never" ||
      (!effectful && message.params?.sandbox !== "read-only") ||
      message.params?.ephemeral !== true ||
      message.params?.model !== "gpt-5.6-sol"
    ) {
      process.exit(22);
    }
    threadStarted = true;
    respond(message.id!, {
      thread: { id: effectful ? "thread-workspace-write-1" : "thread-read-only-1" },
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    continue;
  }
  if (message.method === "turn/start") {
    const sandboxPolicy = message.params?.sandboxPolicy as
      | { type?: string; networkAccess?: boolean }
      | undefined;
    if (
      !threadStarted ||
      message.params?.threadId !==
        (effectful ? "thread-workspace-write-1" : "thread-read-only-1") ||
      message.params?.approvalPolicy !== "never" ||
      sandboxPolicy?.type !== (effectful ? "workspaceWrite" : "readOnly") ||
      sandboxPolicy.networkAccess !== false
    ) {
      process.exit(23);
    }
    const threadId = effectful ? "thread-workspace-write-1" : "thread-read-only-1";
    const turnId = effectful ? "turn-workspace-write-1" : "turn-read-only-1";
    respond(message.id!, { turn: { id: turnId, status: "inProgress" } });
    if (effectful) {
      if (effectMode === "wait-and-write") {
        if (!releasePath) process.exit(27);
        while (!(await stat(releasePath).catch(() => undefined))) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await mkdir("src", { recursive: true });
        await writeFile("src/index.ts", "export const answer = 42;\n");
      }
      notify("item/agentMessage/delta", {
        threadId,
        turnId,
        itemId: "message-effectful-1",
        delta:
          "Implemented bounded change.\n" +
          'CMD_RIKER_OUTCOME: {"status":"completed","summary":"Implemented bounded change.",' +
          '"affectedArtifacts":["src/index.ts"],"verificationResults":["Ready for host Verification."]}',
      });
      notify("turn/completed", {
        threadId,
        turn: { id: turnId, status: "completed" },
      });
      continue;
    }
    notify("item/agentMessage/delta", {
      threadId: "thread-read-only-1",
      turnId: "turn-read-only-1",
      itemId: "message-1",
      delta:
        "Read-only result.\n" +
        'CMD_RIKER_OUTCOME: {"status":"completed","summary":"Read-only result.",' +
        '"affectedArtifacts":[],"verificationResults":["Architecture inspected."]}',
    });
    request(0, "item/tool/requestUserInput", {
      threadId: "thread-read-only-1",
      turnId: "turn-read-only-1",
      itemId: "question-item-1",
      questions: [
        {
          id: "module",
          header: "Module",
          question: "Which module?",
          options: [{ label: "State", description: "Inspect state." }],
          isOther: true,
          isSecret: false,
        },
      ],
    });
    continue;
  }
  if (message.method === "turn/interrupt") {
    if (
      message.params?.threadId !== "thread-read-only-1" ||
      message.params?.turnId !== "turn-read-only-1"
    ) {
      process.exit(25);
    }
    respond(message.id!, {});
    notify("turn/completed", {
      threadId: "thread-read-only-1",
      turn: { id: "turn-read-only-1", status: "interrupted" },
    });
    continue;
  }
  if (message.id === 0 && message.result) {
    const result = message.result as { answers?: { module?: { answers?: string[] } } };
    if (result.answers?.module?.answers?.[0] !== "State") process.exit(24);
    notify("serverRequest/resolved", {
      threadId: "thread-read-only-1",
      requestId: 0,
    });
    notify("turn/completed", {
      threadId: "thread-read-only-1",
      turn: { id: "turn-read-only-1", status: "completed" },
    });
  }
}

function respond(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function request(id: number, method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
}

function notify(method: string, params: unknown): void {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}
