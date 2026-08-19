import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { WorkerReportedOutcome } from "../orchestration-core/index.ts";
import type {
  CodexWorkerExecution,
  CodexWorkerHarness,
  WorkerExecutionObserver,
  WorkerStartRequest,
} from "./index.ts";

const supportedVersion = "codex-cli 0.147.0";
// Digest of the generated 0.147.0 schema retained by the accepted lifecycle probe (66849d0).
const supportedSchemaSha256 = "BABFD5C98CD978DD858B4762CDFBC9FBA941E1A0E4053DE0050E4082AE1F075A";
const maxStdoutBuffer = 2 * 1024 * 1024;
const maxQuestionBytes = 24 * 1024;

export type CodexRuntime = {
  executable: string;
  args: string[];
  version: string;
};

export function createCodexWorkerHarness(runtime: CodexRuntime): CodexWorkerHarness {
  if (runtime.version !== supportedVersion) {
    throw new Error(`Unsupported Codex version ${runtime.version}; expected ${supportedVersion}.`);
  }
  return new CodexAppServerHarness(runtime);
}

export async function resolveCodexRuntime(): Promise<CodexRuntime> {
  if (process.platform !== "win32") {
    throw new Error("The Codex Worker runtime resolver supports Windows only.");
  }
  const command = (await execText("where.exe", ["codex.cmd"]))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!command) throw new Error("codex.cmd was not found.");
  const npmRoot = dirname(resolve(command));
  const packageRoot = join(npmRoot, "node_modules", "@openai", "codex");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    optionalDependencies?: Record<string, string>;
  };
  const platformPackage = Object.keys(manifest.optionalDependencies ?? {}).find(
    (name) => name === "@openai/codex-win32-x64",
  );
  if (!platformPackage) throw new Error("Installed Codex does not declare its Windows payload.");
  const relativePackage = join(...platformPackage.split("/"));
  const platformRoot = [
    join(packageRoot, "node_modules", relativePackage),
    join(npmRoot, "node_modules", relativePackage),
  ].find((candidate) => existsSync(candidate));
  if (!platformRoot) throw new Error("The native Codex Windows payload is missing.");
  const executable = join(
    platformRoot,
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
  const version = (await execText(executable, ["--version"])).trim();
  if (version !== supportedVersion) {
    throw new Error(`Unsupported Codex version ${version}; expected ${supportedVersion}.`);
  }
  const help = await execText(executable, ["app-server", "--help"]);
  if (!/stdio/i.test(help)) throw new Error("Codex app-server stdio support is unavailable.");
  const loginStatus = await execMerged(executable, ["login", "status"]);
  if (
    /\b(?:not|no longer)\s+logged\s+in\b/i.test(loginStatus) ||
    !/logged\s+in\s+using\s+ChatGPT\b/i.test(loginStatus)
  ) {
    throw new Error("Codex authentication is unavailable.");
  }
  return {
    executable,
    args: ["app-server", "--stdio", "--enable", "default_mode_request_user_input"],
    version,
  };
}

class CodexAppServerHarness implements CodexWorkerHarness {
  readonly selection = { provider: "openai", nativeHarness: "codex" } as const;
  readonly supportsEffectful = true;
  private readonly runtime: CodexRuntime;

  constructor(runtime: CodexRuntime) {
    this.runtime = runtime;
  }

  async start(
    request: WorkerStartRequest,
    observer: WorkerExecutionObserver,
  ): Promise<CodexWorkerExecution> {
    if (!request.readOnly && process.platform !== "win32") {
      throw new Error("Effectful Codex Worker assignments require Windows write isolation.");
    }
    if (
      !request.readOnly &&
      resolve(request.authorizedWriteRoot) !== resolve(request.targetProjectPath)
    ) {
      throw new Error("The Codex Authorized Write Root must be the Target Project checkout.");
    }
    const transport = new JsonlTransport(this.runtime, request.targetProjectPath);
    const queuedMessages: ProtocolMessage[] = [];
    let providerSessionId: string | undefined;
    let nativeExecutionId: string | undefined;
    let outputText = "";
    let terminalObserved = false;
    let terminating = false;
    let isolationFailure: string | undefined;
    const answerDeliveries = new Map<
      string,
      { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }
    >();

    const route = (message: ProtocolMessage): void => {
      if (message.method === "windows/worldWritableWarning") {
        const warning = asRecord(message.params);
        const samplePaths = Array.isArray(warning.samplePaths)
          ? warning.samplePaths.map(String)
          : [];
        if (warning.failedScan === true || samplePaths.length > 0 || Number(warning.extraCount) > 0) {
          isolationFailure =
            "Codex reported Windows paths that cannot be protected by its write sandbox.";
        }
        return;
      }
      if (!providerSessionId || !nativeExecutionId) {
        queuedMessages.push(message);
        return;
      }
      const params = asRecord(message.params);
      if (params.threadId !== providerSessionId) return;
      if (message.method === "serverRequest/resolved") {
        const delivery = answerDeliveries.get(String(params.requestId));
        if (delivery) {
          answerDeliveries.delete(String(params.requestId));
          clearTimeout(delivery.timer);
          delivery.resolve();
        }
        return;
      }
      const messageTurnId =
        typeof params.turnId === "string"
          ? params.turnId
          : typeof asRecord(params.turn).id === "string"
            ? asRecord(params.turn).id
            : undefined;
      if (messageTurnId !== nativeExecutionId) return;
      if (message.method === "item/agentMessage/delta") {
        outputText = `${outputText}${String(params.delta ?? "")}`.slice(-64 * 1024);
        return;
      }
      if (message.method === "item/completed") {
        const item = asRecord(params.item);
        if (item.type === "agentMessage" && typeof item.text === "string") {
          outputText = item.text.slice(-64 * 1024);
        }
        if (item.type === "commandExecution") {
          const command =
            typeof item.command === "string"
              ? item.command
              : Array.isArray(item.command)
                ? item.command.map(String).join(" ")
                : undefined;
          if (command) observer.materialCommand?.(command.slice(0, 8 * 1024));
        }
        return;
      }
      if (message.method === "item/tool/requestUserInput" && message.id !== undefined) {
        try {
          observer.question(validateQuestion(message.id, params));
        } catch (error) {
          transport.deny(message.id, error instanceof Error ? error.message : "Invalid question.");
        }
        return;
      }
      if (message.method === "turn/completed" && !terminalObserved) {
        const status = asRecord(params.turn).status;
        if (status === "completed" || status === "failed" || status === "interrupted") {
          terminalObserved = true;
          setTimeout(() => {
            const reported = parseWorkerReportedOutcome(outputText);
            if (reported.output) observer.output(reported.output);
            void Promise.resolve(
              observer.completed(
                status,
                status === "failed" ? JSON.stringify(asRecord(params.turn).error ?? null) : undefined,
                reported.outcome,
              ),
            ).catch((error: unknown) => observer.failed(asError(error)));
          }, 1_000);
        }
      }
    };

    transport.onMessage = route;
    transport.onFailure = (error) => {
      for (const delivery of answerDeliveries.values()) {
        clearTimeout(delivery.timer);
        delivery.reject(error);
      }
      answerDeliveries.clear();
      if (!terminating) void observer.failed(error);
    };
    const processIdentity = await transport.start();
    observer.processStarted({
      process: processIdentity,
      harnessVersion: this.runtime.version,
      protocolSchemaSha256: supportedSchemaSha256,
    });
    try {
      const initialized = asRecord(
        await transport.request("initialize", {
          clientInfo: { name: "cmd-riker", version: "1" },
          capabilities: { experimentalApi: true },
        }),
      );
      if (typeof initialized.userAgent !== "string" || !initialized.userAgent.includes("0.147.0")) {
        throw new Error("Codex app-server returned an unproven protocol identity.");
      }
      transport.notify("initialized", {});
      if (!request.readOnly) {
        await proveWorkspaceWriteIsolation(transport, request.authorizedWriteRoot);
        if (isolationFailure) throw new Error(isolationFailure);
      }
      const threadResult = asRecord(
        await transport.request("thread/start", {
          cwd: request.targetProjectPath,
          approvalPolicy: "never",
          sandbox: request.readOnly ? "read-only" : "workspace-write",
          ephemeral: true,
          model: request.model,
          config: { model_reasoning_effort: "high" },
        }),
      );
      const thread = asRecord(threadResult.thread);
      if (typeof thread.id !== "string" || !thread.id) throw new Error("Codex returned no thread id.");
      if (threadResult.model !== undefined && threadResult.model !== request.model) {
        throw new Error("Codex selected a different Model than requested.");
      }
      providerSessionId = thread.id;
      if (!request.readOnly) {
        if (isolationFailure) throw new Error(isolationFailure);
        await observer.effectDispatchStarted?.();
      }
      const turnResult = asRecord(
        await transport.request("turn/start", {
          threadId: providerSessionId,
          input: [
            {
              type: "text",
              text:
                (request.readOnly
                  ? `Read-only assignment: ${request.objective}\n\n${request.prompt}\n\n`
                  : `Effectful assignment: ${request.objective}\n\n${request.prompt}\n\n` +
                    `Authorized targets: ${JSON.stringify(request.targets)}\n` +
                    `Authorized Write Root: ${request.authorizedWriteRoot}\n` +
                    `Deadline: ${request.timeoutMs}ms. Recovery: ${request.recoveryConstraint}.\n\n`) +
                (request.priorAnswers?.length
                  ? `Retained Owner answers from the same Worker Session: ${JSON.stringify(request.priorAnswers)}\n\n`
                  : "") +
                (request.readOnly
                  ? "Do not modify files, configuration, credentials, processes, or external state. "
                  : "Modify only assigned targets inside the Authorized Write Root. Do not access network services, credentials, global configuration, or external state. ") +
                "Report findings and evidence only. End with exactly one line beginning " +
                "CMD_RIKER_OUTCOME: followed by JSON with status (completed or blocked), summary, " +
                "affectedArtifacts, verificationResults, and optional unresolvedUncertainty.",
            },
          ],
          cwd: request.targetProjectPath,
          model: request.model,
          effort: "high",
          approvalPolicy: "never",
          sandboxPolicy: request.readOnly
            ? { type: "readOnly", networkAccess: false }
            : workspaceWritePolicy(),
        }),
      );
      const turn = asRecord(turnResult.turn);
      if (typeof turn.id !== "string" || !turn.id) throw new Error("Codex returned no turn id.");
      nativeExecutionId = turn.id;
      for (const message of queuedMessages.splice(0)) route(message);
    } catch (error) {
      terminating = true;
      await transport.terminate();
      throw error;
    }

    return {
      identity: {
        providerSessionId,
        nativeExecutionId,
        process: processIdentity,
        harnessVersion: this.runtime.version,
        protocolSchemaSha256: supportedSchemaSha256,
        capabilities: {
          readOnly: request.readOnly,
          nativeQuestions: true,
          cancellation: true,
          providerSessionResume: false,
          providerSessionLoad: "unavailable",
          providerSessionDeletion: false,
          nativeChildControl: false,
          exactExecutionResume: "live-connection-only",
          protocolSchemaSha256: supportedSchemaSha256,
          ...(!request.readOnly
            ? { writeIsolation: "authorized-write-root-enforced" as const }
            : {}),
        },
        ...(!request.readOnly
          ? { writeIsolation: "codex-windows-workspace-write" as const }
          : {}),
      },
      async answer(providerRequestId, answers) {
        const delivery = Promise.withResolvers<void>();
        const key = String(providerRequestId);
        if (answerDeliveries.has(key)) {
          throw new Error(`Codex server request ${providerRequestId} already has pending delivery.`);
        }
        const timer = setTimeout(() => {
          answerDeliveries.delete(key);
          delivery.reject(new Error(`Codex answer ${providerRequestId} delivery was not confirmed.`));
        }, 10_000);
        answerDeliveries.set(key, { ...delivery, timer });
        try {
          transport.respond(providerRequestId, {
            answers: Object.fromEntries(
              Object.entries(answers).map(([questionId, values]) => [
                questionId,
                { answers: values },
              ]),
            ),
          });
        } catch (error) {
          clearTimeout(timer);
          answerDeliveries.delete(key);
          throw error;
        }
        await delivery.promise;
      },
      async interrupt() {
        await transport.request(
          "turn/interrupt",
          { threadId: providerSessionId, turnId: nativeExecutionId },
          10_000,
        );
      },
      async terminate() {
        terminating = true;
        for (const delivery of answerDeliveries.values()) {
          clearTimeout(delivery.timer);
          delivery.reject(new Error("Codex execution terminated before answer delivery."));
        }
        answerDeliveries.clear();
        return { gone: await transport.terminate() };
      },
    };
  }

  async abandon(processIdentity: { pid: number; startedAt: string }): Promise<{ gone: boolean }> {
    return { gone: await terminateRecordedProcess(processIdentity.pid, processIdentity.startedAt) };
  }
}

type ProtocolMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

class JsonlTransport {
  onMessage: (message: ProtocolMessage) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly serverRequests = new Set<number | string>();
  private readonly runtime: CodexRuntime;
  private readonly cwd: string;

  constructor(runtime: CodexRuntime, cwd: string) {
    this.runtime = runtime;
    this.cwd = cwd;
  }

  async start(): Promise<{ pid: number; startedAt: string }> {
    const child = spawn(this.runtime.executable, this.runtime.args, {
      cwd: this.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: safeChildEnvironment(),
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.accept(chunk));
    child.stderr.on("data", () => {});
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => {
      this.child = undefined;
      this.fail(new Error(`Codex app-server exited (code=${code}, signal=${signal}).`));
    });
    await new Promise<void>((resolveStart, reject) => {
      child.once("spawn", resolveStart);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("Codex app-server returned no process id.");
    const processIdentity = await inspectProcess(child.pid);
    if (!processIdentity?.startedAt) {
      await this.terminate();
      throw new Error("Codex process start identity could not be proven.");
    }
    return { pid: child.pid, startedAt: processIdentity.startedAt };
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextId++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    if (!this.serverRequests.delete(id)) {
      throw new Error(`Codex server request ${id} was already answered or is unknown.`);
    }
    this.write({ id, result });
  }

  deny(id: number | string, message: string): void {
    if (!this.serverRequests.delete(id)) return;
    this.write({ id, error: { code: -32000, message } });
  }

  async terminate(): Promise<boolean> {
    const pid = this.child?.pid;
    if (!pid) return true;
    const gone = await terminateProcessTree(pid);
    if (gone) this.child = undefined;
    return gone;
  }

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server is not running.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private accept(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > maxStdoutBuffer && this.buffer.indexOf(0x0a) === -1) {
      this.fail(new Error(`Codex stdout framing exceeded ${maxStdoutBuffer} bytes.`));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) return;
      const line = this.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > maxStdoutBuffer) {
        this.fail(new Error(`Codex stdout framing exceeded ${maxStdoutBuffer} bytes.`));
        return;
      }
      let message: ProtocolMessage;
      try {
        message = JSON.parse(line) as ProtocolMessage;
      } catch {
        this.fail(new Error("Codex app-server emitted malformed JSON."));
        return;
      }
      if (message.id !== undefined && !message.method) {
        const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
        if (!pending) continue;
        this.pending.delete(message.id as number);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed."));
        else pending.resolve(message.result);
      } else {
        if (message.id !== undefined && message.method) this.serverRequests.add(message.id);
        this.onMessage(message);
      }
    }
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

export async function proveCodexWorkspaceWriteIsolation(
  runtime: CodexRuntime,
  authorizedWriteRoot: string,
): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Codex workspace-write isolation is supported on Windows only.");
  }
  if (runtime.version !== supportedVersion) {
    throw new Error(`Unsupported Codex version ${runtime.version}; expected ${supportedVersion}.`);
  }
  const transport = new JsonlTransport(runtime, authorizedWriteRoot);
  let isolationFailure: string | undefined;
  transport.onMessage = (message) => {
    if (message.method !== "windows/worldWritableWarning") return;
    const warning = asRecord(message.params);
    const samplePaths = Array.isArray(warning.samplePaths) ? warning.samplePaths : [];
    if (warning.failedScan === true || samplePaths.length > 0 || Number(warning.extraCount) > 0) {
      isolationFailure = "Codex reported Windows paths that cannot be protected by its write sandbox.";
    }
  };
  transport.onFailure = () => {};
  await transport.start();
  try {
    const initialized = asRecord(
      await transport.request("initialize", {
        clientInfo: { name: "cmd-riker", version: "1" },
        capabilities: { experimentalApi: true },
      }),
    );
    if (typeof initialized.userAgent !== "string" || !initialized.userAgent.includes("0.147.0")) {
      throw new Error("Codex app-server returned an unproven protocol identity.");
    }
    transport.notify("initialized", {});
    await proveWorkspaceWriteIsolation(transport, authorizedWriteRoot);
    if (isolationFailure) throw new Error(isolationFailure);
  } finally {
    await transport.terminate();
  }
}

function workspaceWritePolicy() {
  return {
    type: "workspaceWrite" as const,
    writableRoots: [] as string[],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

async function proveWorkspaceWriteIsolation(
  transport: JsonlTransport,
  authorizedWriteRoot: string,
): Promise<void> {
  const readiness = asRecord(await transport.request("windowsSandbox/readiness", null, 10_000));
  if (readiness.status !== "ready") {
    throw new Error(`Codex Windows write isolation is ${String(readiness.status ?? "unknown")}.`);
  }
  const probeDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-isolation-probe-"));
  const token = randomUUID();
  const allowedPath = join(authorizedWriteRoot, `.cmd-riker-write-probe-${token}`);
  const deniedPath = join(probeDirectory, `denied-${token}`);
  const command = (path: string) => [
    process.execPath,
    "-e",
    'process.getBuiltinModule("node:fs").writeFileSync(process.argv[1], "cmd-riker-isolation-probe")',
    path,
  ];
  let boundaryViolation = false;
  try {
    const allowed = asRecord(
      await transport.request(
        "command/exec",
        {
          command: command(allowedPath),
          cwd: authorizedWriteRoot,
          timeoutMs: 10_000,
          sandboxPolicy: workspaceWritePolicy(),
        },
        15_000,
      ),
    );
    if (
      allowed.exitCode !== 0 ||
      (await readFile(allowedPath, "utf8").catch(() => "")) !== "cmd-riker-isolation-probe"
    ) {
      throw new Error("Codex Windows write isolation did not permit an in-root probe write.");
    }
    let denied: Record<string, unknown> | undefined;
    try {
      denied = asRecord(
        await transport.request(
          "command/exec",
          {
            command: command(deniedPath),
            cwd: authorizedWriteRoot,
            timeoutMs: 10_000,
            sandboxPolicy: workspaceWritePolicy(),
          },
          15_000,
        ),
      );
    } catch {
      // A sandbox-level JSON-RPC rejection is the expected denial shape on Windows.
    }
    const deniedPathExists = await access(deniedPath).then(() => true, () => false);
    if (denied?.exitCode === 0 || deniedPathExists) {
      boundaryViolation = deniedPathExists;
      throw new Error(
        `Codex Windows write isolation permitted an out-of-root probe write at ${deniedPath}.`,
      );
    }
  } finally {
    await rm(allowedPath, { force: true }).catch(() => undefined);
    if (!boundaryViolation) {
      await rm(probeDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function validateQuestion(
  providerRequestId: number | string,
  params: Record<string, unknown>,
): Parameters<WorkerExecutionObserver["question"]>[0] {
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > maxQuestionBytes) {
    throw new Error("Codex question exceeds the supported size.");
  }
  if (typeof params.itemId !== "string" || !params.itemId.trim()) {
    throw new Error("Codex question has no item identity.");
  }
  if (!Array.isArray(params.questions) || params.questions.length === 0) {
    throw new Error("Codex request has no answerable questions.");
  }
  return {
    providerRequestId,
    itemId: params.itemId,
    questions: params.questions.map((value) => {
      const question = asRecord(value);
      if (
        typeof question.id !== "string" ||
        !question.id.trim() ||
        typeof question.question !== "string" ||
        !question.question.trim() ||
        question.isSecret === true
      ) {
        throw new Error("Codex question is invalid or secret.");
      }
      const options = Array.isArray(question.options)
        ? question.options.map((optionValue) => {
            const option = asRecord(optionValue);
            if (typeof option.label !== "string" || !option.label.trim()) {
              throw new Error("Codex question option has no label.");
            }
            return {
              label: option.label,
              ...(typeof option.description === "string"
                ? { description: option.description }
                : {}),
            };
          })
        : undefined;
      if (!options?.length && question.isOther !== true) {
        throw new Error("Codex question has no supported answer surface.");
      }
      return {
        id: question.id,
        question: question.question,
        ...(options ? { options } : {}),
        isOther: question.isOther === true,
      };
    }),
  };
}

export function parseWorkerReportedOutcome(output: string): {
  output: string;
  outcome?: WorkerReportedOutcome;
} {
  const lines = output.trimEnd().split(/\r?\n/);
  const marker = "CMD_RIKER_OUTCOME:";
  const outcomeLine = lines.at(-1);
  if (!outcomeLine?.startsWith(marker)) return { output };
  let value: unknown;
  try {
    value = JSON.parse(outcomeLine.slice(marker.length).trim());
  } catch {
    return { output };
  }
  const reported = asRecord(value);
  if (
    (reported.status !== "completed" && reported.status !== "blocked") ||
    typeof reported.summary !== "string" ||
    !reported.summary.trim() ||
    !isStringArray(reported.affectedArtifacts) ||
    !isStringArray(reported.verificationResults) ||
    (reported.unresolvedUncertainty !== undefined &&
      typeof reported.unresolvedUncertainty !== "string")
  ) {
    return { output };
  }
  return {
    output: lines.slice(0, -1).join("\n").trimEnd(),
    outcome: {
      status: reported.status,
      summary: reported.summary,
      affectedArtifacts: reported.affectedArtifacts,
      verificationResults: reported.verificationResults,
      ...(typeof reported.unresolvedUncertainty === "string"
        ? { unresolvedUncertainty: reported.unresolvedUncertainty }
        : {}),
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export async function inspectProcess(pid: number): Promise<{ pid: number; startedAt: string | null } | null> {
  if (!isAlive(pid)) return null;
  if (process.platform !== "win32") return { pid, startedAt: null };
  const script = [
    `$p=Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue`,
    "if($p){$p.CreationDate.ToUniversalTime().ToString('o')}",
  ].join(";");
  const output = (await execText("powershell.exe", ["-NoProfile", "-Command", script])).trim();
  return output ? { pid, startedAt: new Date(output).toISOString() } : null;
}

export async function terminateRecordedProcess(pid: number, startedAt: string): Promise<boolean> {
  const actual = await inspectProcess(pid);
  if (!actual) return true;
  if (actual.startedAt !== new Date(startedAt).toISOString()) return false;
  return terminateProcessTree(pid);
}

async function terminateProcessTree(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () =>
        resolveKill(),
      );
    });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return true;
    }
  }
  const deadline = Date.now() + 10_000;
  while (isAlive(pid) && Date.now() < deadline) await wait(25);
  return !isAlive(pid);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export function safeChildEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === "win32"
    ? [
        "APPDATA",
        "CODEX_HOME",
        "ComSpec",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "SystemDrive",
        "SystemRoot",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "windir",
      ]
    : ["HOME", "LANG", "PATH", "SHELL", "TMPDIR"];
  return Object.fromEntries(
    names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]),
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
    execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
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
