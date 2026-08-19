import { createHash, randomUUID } from "node:crypto";
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

const supportedVersions = new Set(["2.1.229 (Claude Code)", "2.1.233 (Claude Code)"]);
const protocolSchemaSha256 = createHash("sha256")
  .update("claude-stream-json:system/init,assistant,result,control_response@2.1.229-2.1.233")
  .digest("hex")
  .toUpperCase();
const maximumStdoutRecordBytes = 16 * 1024 * 1024;
const maximumStderrBytes = 16 * 1024;

export type ClaudeRuntime = {
  executable: string;
  args: string[];
  version: string;
};

export function createClaudeWorkerHarness(runtime: ClaudeRuntime): NativeWorkerHarness {
  if (!supportedVersions.has(runtime.version)) {
    throw new Error(`Unsupported Claude version ${runtime.version}.`);
  }
  return new ClaudeStreamJsonHarness(runtime);
}

export async function resolveClaudeRuntime(): Promise<ClaudeRuntime> {
  if (process.platform !== "win32") {
    throw new Error("The Claude Worker runtime resolver supports Windows only.");
  }
  const executable = (await execText("where.exe", ["claude.exe"]))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && existsSync(line));
  if (!executable) throw new Error("claude.exe was not found.");
  const version = (await execText(resolve(executable), ["--version"])).trim();
  if (!supportedVersions.has(version)) {
    throw new Error(`Unsupported Claude version ${version}.`);
  }
  const auth = JSON.parse(await execText(resolve(executable), ["auth", "status", "--json"])) as {
    loggedIn?: boolean;
  };
  if (auth.loggedIn !== true) throw new Error("Claude authentication is unavailable.");
  return { executable: resolve(executable), args: [], version };
}

class ClaudeStreamJsonHarness implements NativeWorkerHarness {
  readonly selection = { provider: "anthropic", nativeHarness: "claude" } as const;
  readonly supportsEffectful = false;
  private readonly runtime: ClaudeRuntime;

  constructor(runtime: ClaudeRuntime) {
    this.runtime = runtime;
  }

  async start(
    request: WorkerStartRequest,
    observer: WorkerExecutionObserver,
  ): Promise<NativeWorkerExecution> {
    if (!request.readOnly) {
      throw new Error(
        "Claude effectful assignments are unavailable because Authorized Write Root enforcement is not proven.",
      );
    }
    const child = spawn(
      this.runtime.executable,
      [
        ...this.runtime.args,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        request.model,
        "--effort",
        "high",
        "--permission-mode",
        "manual",
        "--tools",
        "Read,Glob,Grep",
        "--allowedTools",
        "Read,Glob,Grep",
        "--safe-mode",
        "--no-session-persistence",
      ],
      {
        cwd: request.targetProjectPath,
        env: safeChildEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const spawned = Promise.withResolvers<void>();
    child.once("spawn", spawned.resolve);
    child.once("error", spawned.reject);
    await spawned.promise;
    if (!child.pid) throw new Error("Claude returned no process id.");
    const inspected = await inspectProcess(child.pid);
    if (!inspected?.startedAt) {
      await terminateRecordedProcess(child.pid, new Date().toISOString()).catch(() => false);
      throw new Error("Claude process start identity could not be proven.");
    }
    const processIdentity = { pid: child.pid, startedAt: inspected.startedAt };
    observer.processStarted({
      process: processIdentity,
      harnessVersion: this.runtime.version,
      protocolSchemaSha256,
    });

    const initialized = Promise.withResolvers<{
      providerSessionId: string;
      cancellation: boolean;
    }>();
    void initialized.promise.catch(() => {});
    const controlResponses = new Map<
      string,
      { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }
    >();
    let stdoutBuffer = Buffer.alloc(0);
    let stderr = "";
    let output = "";
    let terminalObserved = false;
    let terminating = false;
    let initializationObserved = false;

    const fail = (error: Error): void => {
      if (!initializationObserved) initialized.reject(error);
      for (const response of controlResponses.values()) {
        clearTimeout(response.timer);
        response.reject(error);
      }
      controlResponses.clear();
      if (!terminating && !terminalObserved) void observer.failed(error);
    };
    const acceptEvent = (value: unknown): void => {
      const event = asRecord(value);
      if (event.type === "system" && event.subtype === "init") {
        if (initializationObserved) return;
        const providerSessionId = typeof event.session_id === "string" ? event.session_id : "";
        const version = typeof event.claude_code_version === "string"
          ? `${event.claude_code_version} (Claude Code)`
          : "";
        if (
          !providerSessionId ||
          version !== this.runtime.version ||
          event.model !== request.model
        ) {
          fail(new Error(
            `Claude returned an unproven identity (version=${version || "missing"}, model=${String(event.model ?? "missing")}).`,
          ));
          return;
        }
        const advertised = Array.isArray(event.capabilities) ? event.capabilities.map(String) : [];
        initializationObserved = true;
        initialized.resolve({
          providerSessionId,
          cancellation: advertised.includes("interrupt_receipt_v1"),
        });
        return;
      }
      if (event.type === "assistant") {
        const message = asRecord(event.message);
        if (!Array.isArray(message.content)) return;
        for (const blockValue of message.content) {
          const block = asRecord(blockValue);
          if (block.type === "text" && typeof block.text === "string") {
            output = `${output}${block.text}`.slice(-64 * 1024);
          } else if (
            block.type === "tool_use" &&
            !["Read", "Glob", "Grep"].includes(String(block.name))
          ) {
            fail(new Error(`Claude attempted unavailable tool ${String(block.name)}.`));
          }
        }
        return;
      }
      if (event.type === "control_response") {
        const response = asRecord(event.response);
        const requestId = typeof response.request_id === "string" ? response.request_id : "";
        const pending = controlResponses.get(requestId);
        if (!pending) return;
        controlResponses.delete(requestId);
        clearTimeout(pending.timer);
        if (response.subtype === "success") pending.resolve(asRecord(response.response));
        else pending.reject(new Error(String(response.error ?? "Claude interruption failed.")));
        return;
      }
      if (event.type === "result" && !terminalObserved) {
        terminalObserved = true;
        if (typeof event.result === "string") output = event.result.slice(-64 * 1024);
        const reported = parseWorkerReportedOutcome(output);
        if (reported.output) observer.output(reported.output);
        const interrupted = event.terminal_reason === "aborted_streaming";
        void Promise.resolve(
          observer.completed(
            interrupted ? "interrupted" : event.is_error === true ? "failed" : "completed",
            event.is_error === true && !interrupted ? String(event.result ?? event.subtype ?? "") : undefined,
            reported.outcome,
          ),
        ).catch((error: unknown) => observer.failed(asError(error)));
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
      while (true) {
        const newline = stdoutBuffer.indexOf(0x0a);
        if (newline === -1) break;
        if (newline > maximumStdoutRecordBytes) {
          fail(new Error(`Claude stdout framing exceeded ${maximumStdoutRecordBytes} bytes.`));
          return;
        }
        const line = stdoutBuffer.subarray(0, newline).toString("utf8").trim();
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        if (!line) continue;
        try {
          acceptEvent(JSON.parse(line));
        } catch {
          fail(new Error("Claude emitted malformed JSONL."));
        }
      }
      if (stdoutBuffer.length > maximumStdoutRecordBytes) {
        fail(new Error(`Claude stdout framing exceeded ${maximumStdoutRecordBytes} bytes.`));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-maximumStderrBytes);
    });
    child.on("error", (error) => fail(error));
    child.on("exit", (code, signal) => {
      if (!terminating && !terminalObserved) {
        fail(new Error(`Claude exited (code=${code}, signal=${signal}): ${stderr}`.trim()));
      }
    });

    const nativeExecutionId = randomUUID();
    child.stdin.write(
      `${JSON.stringify({
        type: "user",
        uuid: nativeExecutionId,
        session_id: "",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: readOnlyPrompt(request),
            },
          ],
        },
      })}\n`,
    );
    const init = await withTimeout(initialized.promise, 15_000, "Claude initialization");
    const capabilities = {
      readOnly: true,
      nativeQuestions: false,
      cancellation: init.cancellation,
      providerSessionResume: "conversation-replay-only" as const,
      providerSessionDeletion: false,
      nativeChildControl: false,
      exactExecutionResume: "live-connection-only" as const,
      protocolSchemaSha256,
    };

    return {
      identity: {
        providerSessionId: init.providerSessionId,
        nativeExecutionId,
        process: processIdentity,
        harnessVersion: this.runtime.version,
        protocolSchemaSha256,
        capabilities,
      },
      async answer() {
        throw new Error("Claude native questions are unavailable through the direct CLI transport.");
      },
      async interrupt() {
        if (!capabilities.cancellation) throw new Error("Claude cancellation is unavailable.");
        const requestId = randomUUID();
        const response = Promise.withResolvers<Record<string, unknown>>();
        const timer = setTimeout(() => {
          controlResponses.delete(requestId);
          response.reject(new Error("Claude interruption timed out."));
        }, 10_000);
        controlResponses.set(requestId, { ...response, timer });
        child.stdin.write(
          `${JSON.stringify({
            type: "control_request",
            request_id: requestId,
            request: { subtype: "interrupt", cancel_queued: true },
          })}\n`,
        );
        await response.promise;
      },
      async terminate() {
        terminating = true;
        return { gone: await terminateRecordedProcess(processIdentity.pid, processIdentity.startedAt) };
      },
    };
  }

  async abandon(processIdentity: { pid: number; startedAt: string }): Promise<{ gone: boolean }> {
    return { gone: await terminateRecordedProcess(processIdentity.pid, processIdentity.startedAt) };
  }
}

function readOnlyPrompt(request: WorkerStartRequest & { readOnly: true }): string {
  return (
    `Read-only assignment: ${request.objective}\n\n${request.prompt}\n\n` +
    (request.priorAnswers?.length
      ? `Retained Owner answers from the same Worker Session: ${JSON.stringify(request.priorAnswers)}\n\n`
      : "") +
    "Use only Read, Glob, and Grep. Do not modify files, configuration, credentials, processes, or external state. " +
    "Report findings and evidence only. End with exactly one line beginning CMD_RIKER_OUTCOME: followed by JSON " +
    "with status (completed or blocked), summary, affectedArtifacts, verificationResults, and optional unresolvedUncertainty."
  );
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms.`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function execText(file: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${file} failed: ${stderr || error.message}`));
      else resolveOutput(stdout);
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
