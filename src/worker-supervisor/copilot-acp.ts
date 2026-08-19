import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type {
  NativeWorkerExecution,
  NativeWorkerHarness,
  WorkerExecutionObserver,
  WorkerStartRequest,
} from "./index.ts";
import {
  inspectProcess,
  parseWorkerReportedOutcome,
  safeChildEnvironment,
  terminateRecordedProcess,
} from "./codex-app-server.ts";

const supportedVersion = "GitHub Copilot CLI 1.0.80.";
const acpVersion = 1;
const protocolSchemaSha256 = createHash("sha256")
  .update("copilot-acp:initialize,session/new,session/prompt,session/update@1.0.80/acp1")
  .digest("hex")
  .toUpperCase();
const maximumFrameBytes = 2 * 1024 * 1024;

export type CopilotRuntime = {
  executable: string;
  args: string[];
  version: string;
};

export function createCopilotWorkerHarness(runtime: CopilotRuntime): NativeWorkerHarness {
  if (runtime.version !== supportedVersion) {
    throw new Error(`Unsupported Copilot version ${runtime.version}; expected ${supportedVersion}.`);
  }
  return new CopilotAcpHarness(runtime);
}

export async function resolveCopilotRuntime(): Promise<CopilotRuntime> {
  if (process.platform !== "win32") {
    throw new Error("The Copilot Worker runtime resolver supports Windows only.");
  }
  const executable = (await execText("where.exe", ["copilot.exe"]))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && existsSync(line));
  if (!executable) throw new Error("copilot.exe was not found.");
  const versionOutput = await execMerged(resolve(executable), ["--version"]);
  const version = versionOutput.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  if (version !== supportedVersion) {
    throw new Error(`Unsupported Copilot version ${version}; expected ${supportedVersion}.`);
  }
  const help = await execMerged(resolve(executable), ["--help"]);
  if (!/(^|\s)--acp(?:\s|$)/m.test(help)) throw new Error("Copilot ACP support is unavailable.");
  return { executable: resolve(executable), args: [], version };
}

class CopilotAcpHarness implements NativeWorkerHarness {
  readonly selection = { provider: "github", nativeHarness: "copilot" } as const;
  readonly supportsEffectful = false;
  private readonly runtime: CopilotRuntime;

  constructor(runtime: CopilotRuntime) {
    this.runtime = runtime;
  }

  async start(
    request: WorkerStartRequest,
    observer: WorkerExecutionObserver,
  ): Promise<NativeWorkerExecution> {
    if (!request.readOnly) {
      throw new Error(
        "Copilot effectful assignments are unavailable because Authorized Write Root enforcement is not proven.",
      );
    }
    const transport = new CopilotAcpTransport(
      this.runtime,
      request.targetProjectPath,
      request.model,
    );
    let output = "";
    let terminalObserved = false;
    let terminating = false;
    transport.onNotification = (message) => {
      if (message.method !== "session/update") return;
      const params = asRecord(message.params);
      const update = asRecord(params.update);
      const content = asRecord(update.content);
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        content.type === "text" &&
        typeof content.text === "string"
      ) {
        output = `${output}${content.text}`.slice(-64 * 1024);
      }
      if (typeof update.title === "string" && update.sessionUpdate === "tool_call") {
        observer.materialCommand?.(update.title.slice(0, 8 * 1024));
      }
    };
    transport.onFailure = (error) => {
      if (!terminating && !terminalObserved) void observer.failed(error);
    };
    const processIdentity = await transport.start();
    observer.processStarted({
      process: processIdentity,
      harnessVersion: this.runtime.version,
      protocolSchemaSha256,
    });
    try {
      const initialized = asRecord(
        await transport.request("initialize", {
          protocolVersion: acpVersion,
          clientCapabilities: {},
          clientInfo: { name: "cmd-riker", title: "CMD Riker", version: "1" },
        }),
      );
      const agentInfo = asRecord(initialized.agentInfo);
      if (
        initialized.protocolVersion !== acpVersion ||
        agentInfo.version !== "1.0.80" ||
        !String(agentInfo.name ?? "").toLowerCase().includes("copilot")
      ) {
        throw new Error("Copilot returned an unproven ACP or agent identity.");
      }
      const agentCapabilities = asRecord(initialized.agentCapabilities);
      const session = asRecord(
        await transport.request("session/new", {
          cwd: request.targetProjectPath,
          mcpServers: [],
        }),
      );
      if (typeof session.sessionId !== "string" || !session.sessionId) {
        throw new Error("Copilot ACP returned no session id.");
      }
      const providerSessionId = session.sessionId;
      const prompt = transport.beginRequest("session/prompt", {
        sessionId: providerSessionId,
        prompt: [{ type: "text", text: readOnlyPrompt(request) }],
      });
      void prompt.promise
        .then(async (value) => {
          if (terminalObserved) return;
          terminalObserved = true;
          const result = asRecord(value);
          const reported = parseWorkerReportedOutcome(output);
          if (reported.output) observer.output(reported.output);
          await observer.completed(
            result.stopReason === "end_turn" ? "completed" : "failed",
            result.stopReason === "end_turn"
              ? undefined
              : `Copilot ACP ended ${String(result.stopReason ?? "without a stop reason")}.`,
            reported.outcome,
          );
        })
        .catch((error: unknown) => observer.failed(asError(error)));
      const capabilities = {
        readOnly: true,
        nativeQuestions: false,
        cancellation: false,
        providerSessionResume: false,
        providerSessionLoad:
          agentCapabilities.loadSession === true
            ? "conversation-replay-only" as const
            : "unavailable" as const,
        providerSessionDeletion: false,
        nativeChildControl: false,
        exactExecutionResume: "live-connection-only" as const,
        protocolSchemaSha256,
      };
      return {
        identity: {
          providerSessionId,
          nativeExecutionId: `session/prompt:${prompt.id}`,
          process: processIdentity,
          harnessVersion: this.runtime.version,
          protocolSchemaSha256,
          capabilities,
        },
        async answer() {
          throw new Error("Copilot native questions are unavailable through the proven ACP seam.");
        },
        async interrupt() {
          throw new Error("Copilot cancellation is unavailable through the proven ACP seam.");
        },
        async terminate() {
          terminating = true;
          const sessionCapabilities = asRecord(agentCapabilities.sessionCapabilities);
          if (sessionCapabilities.close === true) {
            await transport.request("session/close", { sessionId: providerSessionId }, 5_000)
              .catch(() => undefined);
          }
          return { gone: await transport.terminate() };
        },
      };
    } catch (error) {
      terminating = true;
      await transport.terminate();
      throw error;
    }
  }

  async abandon(processIdentity: { pid: number; startedAt: string }): Promise<{ gone: boolean }> {
    return { gone: await terminateRecordedProcess(processIdentity.pid, processIdentity.startedAt) };
  }
}

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

class CopilotAcpTransport {
  onNotification: (message: JsonRpcMessage) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  private readonly runtime: CopilotRuntime;
  private readonly cwd: string;
  private readonly model: string;
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();

  constructor(runtime: CopilotRuntime, cwd: string, model: string) {
    this.runtime = runtime;
    this.cwd = cwd;
    this.model = model;
  }

  async start(): Promise<{ pid: number; startedAt: string }> {
    const child = spawn(
      this.runtime.executable,
      [
        ...this.runtime.args,
        "--acp",
        "--stdio",
        "--no-auto-update",
        "--no-remote-export",
        "--no-remote",
        "--model",
        this.model,
        "--effort",
        "high",
      ],
      {
        cwd: this.cwd,
        env: safeChildEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.accept(chunk));
    child.stderr.on("data", () => {});
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      this.child = undefined;
      this.fail(new Error(`Copilot ACP exited (code=${code}, signal=${signal}).`));
    });
    const spawned = Promise.withResolvers<void>();
    child.once("spawn", spawned.resolve);
    child.once("error", spawned.reject);
    await spawned.promise;
    if (!child.pid) throw new Error("Copilot returned no process id.");
    const inspected = await inspectProcess(child.pid);
    if (!inspected?.startedAt) {
      await this.terminate();
      throw new Error("Copilot process start identity could not be proven.");
    }
    return { pid: child.pid, startedAt: inspected.startedAt };
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    return this.beginRequest(method, params, timeoutMs).promise;
  }

  beginRequest(
    method: string,
    params: unknown,
    timeoutMs = 15_000,
  ): { id: number; promise: Promise<unknown> } {
    if (!this.child?.stdin.writable) throw new Error("Copilot ACP is not running.");
    const id = this.nextId++;
    const response = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      response.reject(new Error(`Copilot ACP ${method} timed out.`));
    }, timeoutMs);
    this.pending.set(id, { ...response, timer });
    this.write({ id, method, params });
    return { id, promise: response.promise };
  }

  async terminate(): Promise<boolean> {
    const pid = this.child?.pid;
    if (!pid) return true;
    const inspected = await inspectProcess(pid);
    if (!inspected?.startedAt) return false;
    const gone = await terminateRecordedProcess(pid, inspected.startedAt);
    if (gone) this.child = undefined;
    return gone;
  }

  private accept(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) break;
      if (newline > maximumFrameBytes) {
        this.fail(new Error(`Copilot ACP framing exceeded ${maximumFrameBytes} bytes.`));
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      try {
        this.route(JSON.parse(line) as JsonRpcMessage);
      } catch {
        this.fail(new Error("Copilot ACP emitted malformed JSON-RPC."));
      }
    }
    if (this.buffer.length > maximumFrameBytes) {
      this.fail(new Error(`Copilot ACP framing exceeded ${maximumFrameBytes} bytes.`));
    }
  }

  private route(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "Copilot ACP request failed."));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === "session/request_permission" && message.id !== undefined) {
      this.replyPermission(message.id, asRecord(message.params));
      return;
    }
    if (message.method === "elicitation/create" && message.id !== undefined) {
      this.write({ id: message.id, result: { action: "cancel" } });
      return;
    }
    if (message.method === "session/update") {
      this.onNotification(message);
      return;
    }
    if (message.id !== undefined) {
      this.write({ id: message.id, error: { code: -32601, message: "Method unavailable." } });
    }
  }

  private replyPermission(id: number | string, params: Record<string, unknown>): void {
    const tool = asRecord(params.toolCall);
    const kind = String(tool.kind ?? "other");
    const options = Array.isArray(params.options) ? params.options.map(asRecord) : [];
    const allowed = ["read", "search", "think"].includes(kind);
    const desired = allowed ? "allow_once" : "reject_once";
    const option = options.find((candidate) => candidate.kind === desired);
    this.write({
      id,
      result: option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } },
    });
  }

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Copilot ACP is not running.");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...asRecord(message) })}\n`);
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onFailure(error);
  }
}

function readOnlyPrompt(request: WorkerStartRequest & { readOnly: true }): string {
  return (
    `Read-only assignment: ${request.objective}\n\n${request.prompt}\n\n` +
    (request.priorAnswers?.length
      ? `Retained Owner answers from the same Worker Session: ${JSON.stringify(request.priorAnswers)}\n\n`
      : "") +
    "Do not modify files, configuration, credentials, processes, or external state. " +
    "Report findings and evidence only. End with exactly one line beginning CMD_RIKER_OUTCOME: followed by JSON " +
    "with status (completed or blocked), summary, affectedArtifacts, verificationResults, and optional unresolvedUncertainty."
  );
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} failed: ${stderr || error.message}`));
      else resolveOutput(stdout);
    });
  });
}

function execMerged(file: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} failed: ${stderr || error.message}`));
      else resolveOutput(`${stdout}${stderr}`);
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
