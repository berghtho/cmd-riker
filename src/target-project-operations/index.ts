import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type { Commitment } from "../orchestration-core/index.ts";

export type WorkerExecutionAttribution = {
  workerSessionId: string;
  executionAttemptId: string;
  generation: number;
};

export type TargetProjectOperationRequest = {
  commitmentId: string;
  operation: { kind: "test"; inputs: Record<string, never> };
  checkout: string;
  workingDirectory: string;
  timeoutMs: number;
  causedByWorker?: WorkerExecutionAttribution;
  actingAuthorityEffectAuthorization?: {
    actingAuthorityId: string;
    authorizationId: string;
    standingOrderId: string;
  };
};

export type TargetProjectOperationDiscovery =
  | {
      status: "verified";
      checkout: { path: string; status: "verified" };
      platform: { name: DeclaredPlatform; status: "verified" };
      taskCli: { version: string; status: "verified" };
      taskfile: { path: string; status: "verified" };
      operation: { semantic: "test"; task: string; status: "verified" };
    }
  | {
      status: "rejected" | "unavailable";
      diagnostic: string;
    };

export type TargetProjectOperationResult = {
  operationAttemptId: string;
  effectIntentId: string;
  commitmentId: string;
  operation: "test";
  status: "succeeded" | "failed" | "timed-out" | "unknown" | "rejected" | "unavailable";
  discovery: TargetProjectOperationDiscovery;
  affectedArtifacts: Array<{
    path: string;
    beforeSha256: string | null;
    afterSha256: string | null;
  }>;
  diagnostics: Array<{
    source: "task-cli";
    stream: "stdout" | "stderr" | "host";
    message: string;
  }>;
  uncertainty: null | { reason: string; nextAction: string };
  startedAt: string;
  completedAt: string;
  causedByWorker?: WorkerExecutionAttribution;
};

export type TargetProjectOperationAttempt = {
  id: string;
  commitmentId: string;
  effectIntentId: string;
  operation: "test";
  checkout: string;
  workingDirectory: string;
  timeoutMs: number;
  discovery: TargetProjectOperationDiscovery;
  status: "ready" | "running" | TargetProjectOperationResult["status"];
  startedAt: string;
  result?: TargetProjectOperationResult;
  causedByWorker?: WorkerExecutionAttribution;
};

export type EffectIntentBase = {
  id: string;
  commitmentId: string;
  expectedEffect: string;
  authorizedWriteRootKey?: string;
  effectScopeKey?: string;
  authorization: {
    kind: "lead-agent-command-authority";
    commitmentId: string;
    targetProjectPath?: string;
    providerTarget?: { provider: "github"; resource: string };
    validatedAt: string;
    actingAuthority?: {
      actingAuthorityId: string;
      authorizationId: string;
      standingOrderId: string;
    };
  };
  retryRule: string;
  status: "pending" | "dispatching" | "succeeded" | "unknown" | "rejected" | "reconciled";
  lease?: { claimedAt: string; expiresAt: string };
  reconciliation?: EffectReconciliation;
};

export type ExternalEffectEvidence = {
  source:
    | "target-project-readback"
    | "provider-readback"
    | "compensation-result"
    | "write-generation-and-effect-inventory-readback";
  reference: string;
  summary: string;
  observedAt: string;
};

export type EffectReconciliation = {
  disposition: "confirmed-applied" | "confirmed-not-applied" | "compensated";
  evidence: ExternalEffectEvidence & {
    source: "target-project-readback" | "provider-readback" | "compensation-result";
  };
  reconciledAt: string;
  reconciledBy: "lead-agent";
};

export function assertExternalEffectEvidence(evidence: ExternalEffectEvidence): void {
  if (
    !evidence.reference.trim() ||
    !evidence.summary.trim() ||
    !Number.isFinite(Date.parse(evidence.observedAt))
  ) {
    throw new Error("Effect reconciliation requires attributed external evidence.");
  }
}

export function assertEffectEvidenceSupportsDisposition(
  disposition: EffectReconciliation["disposition"],
  evidence: EffectReconciliation["evidence"],
): void {
  assertExternalEffectEvidence(evidence);
  if (disposition === "compensated") {
    if (evidence.source !== "compensation-result") {
      throw new Error("A compensated effect requires attributed compensation evidence.");
    }
    return;
  }
  if (evidence.source === "compensation-result") {
    throw new Error(`Compensation evidence does not prove disposition ${disposition}.`);
  }
}

export type TargetProjectOperationEffectIntent = EffectIntentBase & {
  kind: "target-project-operation";
  operationAttemptId: string;
  causedByWorker?: WorkerExecutionAttribution;
};

export type WorkerAssignmentEffectIntent = EffectIntentBase & {
  kind: "worker-assignment";
  workerSessionId: string;
  executionAttemptId: string;
  verificationOperationAttemptId?: string;
};

export type ForgeOperationEffectIntent = EffectIntentBase & {
  kind: "forge-operation";
  forgeOperationAttemptId: string;
  provider: "github";
};

export type EffectIntent =
  | TargetProjectOperationEffectIntent
  | WorkerAssignmentEffectIntent
  | ForgeOperationEffectIntent;

export type TaskCliInspection = {
  version: string;
  taskfile: string;
  tasks: string[];
};

export interface TaskCli {
  inspect(input: { checkout: string; timeoutMs: number }): Promise<TaskCliInspection>;
  run(input: {
    operationAttemptId: string;
    effectIntentId: string;
    checkout: string;
    workingDirectory: string;
    taskfile: string;
    task: string;
    timeoutMs: number;
  }): Promise<{
    exitCode: number;
    timedOut: boolean;
    outputTail?: string;
  }>;
}

export interface CheckoutInspector {
  verify(input: { checkout: string; timeoutMs: number }): Promise<{ root: string }>;
}

interface TargetProjectOperationState {
  readOwnerConversation(): { targetProject: { path: string } } | undefined;
  readCommitment(commitmentId: string): Commitment | undefined;
  startTargetProjectOperation(
    attempt: TargetProjectOperationAttempt,
    effectIntent: TargetProjectOperationEffectIntent,
  ): void;
  claimTargetProjectOperationDispatch(
    attempt: TargetProjectOperationAttempt,
    effectIntent: TargetProjectOperationEffectIntent,
  ): void;
  settleTargetProjectOperation(
    attempt: TargetProjectOperationAttempt,
    effectIntent: TargetProjectOperationEffectIntent,
  ): void;
}

export interface TargetProjectOperations {
  execute(request: TargetProjectOperationRequest): Promise<TargetProjectOperationResult>;
}

type DeclaredPlatform = "windows" | "linux" | "darwin";

type OperationDeclaration = {
  task: string;
  platforms: DeclaredPlatform[];
  artifacts: string[];
};

const taskfileNames = new Set([
  "Taskfile.yml",
  "taskfile.yml",
  "Taskfile.yaml",
  "taskfile.yaml",
  "Taskfile.dist.yml",
  "taskfile.dist.yml",
  "Taskfile.dist.yaml",
  "taskfile.dist.yaml",
]);

export function createTargetProjectOperations(
  state: TargetProjectOperationState,
  taskCli: TaskCli = new NativeTaskCli(),
  checkoutInspector: CheckoutInspector = new NativeGitCheckoutInspector(),
): TargetProjectOperations {
  return {
    async execute(request) {
      const operationAttemptId = randomUUID();
      const effectIntentId = randomUUID();
      const startedAt = new Date().toISOString();
      let declaration: Awaited<ReturnType<typeof discoverOperation>>;
      try {
        declaration = await discoverOperation(state, taskCli, checkoutInspector, request);
      } catch (error) {
        const commitment = state.readCommitment(request.commitmentId);
        if (!commitment || commitment.state !== "active" || commitment.condition) throw error;
        const diagnostic = error instanceof Error
          ? error.message
          : "Target Project operation discovery failed.";
        const status = diagnostic.startsWith("Task CLI") || diagnostic.startsWith("Git checkout")
          ? "unavailable"
          : "rejected";
        const discovery: TargetProjectOperationDiscovery = { status, diagnostic };
        const result: TargetProjectOperationResult = {
          operationAttemptId,
          effectIntentId,
          commitmentId: request.commitmentId,
          operation: request.operation.kind,
          status,
          discovery,
          affectedArtifacts: [],
          diagnostics: [{ source: "task-cli", stream: "host", message: diagnostic }],
          uncertainty: null,
          startedAt,
          completedAt: new Date().toISOString(),
          ...(request.causedByWorker ? { causedByWorker: request.causedByWorker } : {}),
        };
        state.startTargetProjectOperation(
          {
            id: operationAttemptId,
            commitmentId: request.commitmentId,
            effectIntentId,
            operation: request.operation.kind,
            checkout: request.checkout,
            workingDirectory: request.workingDirectory,
            timeoutMs: request.timeoutMs,
            ...(request.causedByWorker ? { causedByWorker: request.causedByWorker } : {}),
            discovery,
            status,
            startedAt,
            result,
          },
          {
            id: effectIntentId,
            commitmentId: request.commitmentId,
            operationAttemptId,
            kind: "target-project-operation",
            authorizedWriteRootKey: normalizedAuthorizedWriteRoot(request.checkout),
            expectedEffect: "Discover and run the declared Target Project test operation.",
            authorization: {
              kind: "lead-agent-command-authority",
              commitmentId: request.commitmentId,
              targetProjectPath: request.checkout,
              validatedAt: startedAt,
              ...(request.actingAuthorityEffectAuthorization
                ? { actingAuthority: request.actingAuthorityEffectAuthorization }
                : {}),
            },
            retryRule: "Correct the discovery blocker before starting a new attempt.",
            status: "rejected",
            ...(request.causedByWorker ? { causedByWorker: request.causedByWorker } : {}),
          },
        );
        return result;
      }
      const attempt: TargetProjectOperationAttempt = {
        id: operationAttemptId,
        commitmentId: request.commitmentId,
        effectIntentId,
        operation: request.operation.kind,
        checkout: request.checkout,
        workingDirectory: request.workingDirectory,
        timeoutMs: request.timeoutMs,
        discovery: declaration.discovery,
        status: "running",
        startedAt,
        ...(request.causedByWorker ? { causedByWorker: request.causedByWorker } : {}),
      };
      const effectIntent: EffectIntent = {
        id: effectIntentId,
        commitmentId: request.commitmentId,
        operationAttemptId,
        kind: "target-project-operation",
        authorizedWriteRootKey: normalizedAuthorizedWriteRoot(request.checkout),
        expectedEffect: `Run declared Task task ${JSON.stringify(declaration.task)} for semantic operation test.`,
        authorization: {
          kind: "lead-agent-command-authority",
          commitmentId: request.commitmentId,
          targetProjectPath: request.checkout,
          validatedAt: startedAt,
          ...(request.actingAuthorityEffectAuthorization
            ? { actingAuthority: request.actingAuthorityEffectAuthorization }
            : {}),
        },
        retryRule: "Do not retry unless the prior effect is proven settled.",
        status: "pending",
        ...(request.causedByWorker ? { causedByWorker: request.causedByWorker } : {}),
      };
      const artifactsBefore = await observeArtifacts(request.checkout, declaration.artifacts);
      state.startTargetProjectOperation({ ...attempt, status: "ready" }, effectIntent);
      const claimedAt = new Date().toISOString();
      const claimedEffectIntent: EffectIntent = {
        ...effectIntent,
        status: "dispatching",
        lease: {
          claimedAt,
          expiresAt: new Date(Date.now() + request.timeoutMs).toISOString(),
        },
      };
      state.claimTargetProjectOperationDispatch(attempt, claimedEffectIntent);

      let execution: Awaited<ReturnType<TaskCli["run"]>>;
      let hostDiagnostic: string | undefined;
      try {
        execution = await taskCli.run({
          operationAttemptId,
          effectIntentId,
          checkout: request.checkout,
          workingDirectory: request.workingDirectory,
          taskfile: declaration.discovery.taskfile.path,
          task: declaration.task,
          timeoutMs: request.timeoutMs,
        });
      } catch (error) {
        hostDiagnostic = "Task CLI execution continuity was lost after dispatch.";
        execution = { exitCode: 1, timedOut: false };
      }

      let artifactsAfter: Map<string, string>;
      try {
        artifactsAfter = await observeArtifacts(request.checkout, declaration.artifacts);
      } catch {
        hostDiagnostic = "Declared artifact integrity could not be observed within safety bounds.";
        artifactsAfter = new Map();
      }
      const affectedArtifacts = declaration.artifacts.flatMap((artifact) => {
        const beforeSha256 = artifactsBefore.get(artifact) ?? null;
        const afterSha256 = artifactsAfter.get(artifact) ?? null;
        return beforeSha256 === afterSha256
          ? []
          : [{ path: artifact, beforeSha256, afterSha256 }];
      });
      const status = hostDiagnostic
        ? "unknown"
        : execution.timedOut
          ? "timed-out"
          : execution.exitCode === 0
            ? "succeeded"
            : "failed";
      const uncertainty = status === "succeeded"
        ? null
        : {
            reason: status === "timed-out"
              ? "Task execution exceeded its deadline; interruption does not prove its effects."
              : status === "failed"
                ? "Task reported failure, which does not prove whether partial effects occurred."
                : "Task process or transport continuity was lost after dispatch.",
            nextAction: "Inspect the declared artifacts and Task diagnostics before any retry.",
          };
      const diagnostics: TargetProjectOperationResult["diagnostics"] = [];
      diagnostics.push({
        source: "task-cli",
        stream: "host",
        message: execution.timedOut
          ? "Task exceeded the operation deadline."
          : `Task exited with code ${execution.exitCode}.`,
      });
      if (execution.exitCode !== 0 && execution.outputTail?.trim()) {
        diagnostics.push({
          source: "task-cli",
          stream: "stdout",
          message: execution.outputTail.trim(),
        });
      }
      if (hostDiagnostic) {
        diagnostics.push({ source: "task-cli", stream: "host", message: hostDiagnostic });
      }
      const result: TargetProjectOperationResult = {
        operationAttemptId,
        effectIntentId,
        commitmentId: request.commitmentId,
        operation: request.operation.kind,
        status,
        discovery: declaration.discovery,
        affectedArtifacts,
        diagnostics,
        uncertainty,
        startedAt,
        completedAt: new Date().toISOString(),
        ...(request.causedByWorker ? { causedByWorker: request.causedByWorker } : {}),
      };
      state.settleTargetProjectOperation(
        { ...attempt, status, result },
        { ...claimedEffectIntent, status: status === "succeeded" ? "succeeded" : "unknown" },
      );
      return result;
    },
  };
}

export class NativeTaskCli implements TaskCli {
  private readonly executable: string;
  private readonly prefixArguments: string[];

  constructor(executable = "task", prefixArguments: string[] = []) {
    this.executable = executable;
    this.prefixArguments = prefixArguments;
  }

  async inspect(input: { checkout: string; timeoutMs: number }): Promise<TaskCliInspection> {
    let version: Awaited<ReturnType<typeof execute>>;
    try {
      version = await execute(
        this.executable,
        [...this.prefixArguments, "--version"],
        input.checkout,
        input.timeoutMs,
      );
    } catch {
      throw new Error("Task CLI is unavailable.");
    }
    if (version.exitCode !== 0 || version.timedOut || !version.stdout.trim()) {
      throw new Error("Task CLI is unavailable or did not report its version.");
    }
    let listed: Awaited<ReturnType<typeof execute>>;
    try {
      listed = await execute(
        this.executable,
        [...this.prefixArguments, "--dir", input.checkout, "--list-all", "--json"],
        input.checkout,
        input.timeoutMs,
      );
    } catch {
      throw new Error("Task CLI is unavailable during Taskfile inspection.");
    }
    if (listed.exitCode !== 0 || listed.timedOut) {
      throw new Error("Task CLI could not inspect the Target Project Taskfile.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(listed.stdout);
    } catch {
      throw new Error("Task CLI returned invalid discovery JSON.");
    }
    if (!isTaskList(parsed)) throw new Error("Task CLI returned incomplete discovery JSON.");
    return {
      version: version.stdout.trim(),
      taskfile: parsed.location,
      tasks: parsed.tasks.map((task) => task.name),
    };
  }

  run(input: Parameters<TaskCli["run"]>[0]): ReturnType<TaskCli["run"]> {
    return executeTask(
      this.executable,
      [
        ...this.prefixArguments,
        "--dir",
        input.workingDirectory,
        "--taskfile",
        input.taskfile,
        "--disable-fuzzy",
        "--color=false",
        input.task,
      ],
      input.workingDirectory,
      input.timeoutMs,
    );
  }
}

export class NativeGitCheckoutInspector implements CheckoutInspector {
  async verify(input: { checkout: string; timeoutMs: number }): Promise<{ root: string }> {
    let inspected: Awaited<ReturnType<typeof execute>>;
    try {
      inspected = await execute(
        "git",
        ["-C", input.checkout, "rev-parse", "--show-toplevel"],
        input.checkout,
        input.timeoutMs,
      );
    } catch {
      throw new Error("Git checkout inspection is unavailable.");
    }
    if (inspected.exitCode !== 0 || inspected.timedOut || !inspected.stdout.trim()) {
      throw new Error("The active Target Project path is not a verified Git checkout.");
    }
    return { root: resolve(inspected.stdout.trim()) };
  }
}

async function discoverOperation(
  state: TargetProjectOperationState,
  taskCli: TaskCli,
  checkoutInspector: CheckoutInspector,
  request: TargetProjectOperationRequest,
): Promise<{
  task: string;
  artifacts: string[];
  discovery: Extract<TargetProjectOperationDiscovery, { status: "verified" }>;
}> {
  const configured = state.readOwnerConversation()?.targetProject.path;
  if (!configured || !samePath(configured, request.checkout)) {
    throw new Error("The operation checkout is not the active Target Project.");
  }
  const commitment = state.readCommitment(request.commitmentId);
  if (!commitment || commitment.state !== "active" || commitment.condition) {
    throw new Error("Target Project operations require one active unblocked Commitment.");
  }
  if (
    !commitment.criteria.some(
      (criterion) =>
        criterion.kind === "target-project-operation" &&
        criterion.operation === request.operation.kind,
    )
  ) {
    throw new Error("The Commitment does not declare this Target Project operation criterion.");
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new Error("Target Project operation timeout must be a positive integer.");
  }
  if (!isWithin(request.checkout, request.workingDirectory)) {
    throw new Error("The operation working directory must remain inside the active checkout.");
  }
  const checkoutStat = await stat(request.checkout).catch(() => undefined);
  if (!checkoutStat?.isDirectory()) {
    throw new Error("The active Target Project path is not a verified checkout.");
  }
  const checkoutInspection = await checkoutInspector.verify({
    checkout: request.checkout,
    timeoutMs: Math.min(request.timeoutMs, 5_000),
  });
  if (!samePath(checkoutInspection.root, request.checkout)) {
    throw new Error("The active Target Project path is not the root of the verified Git checkout.");
  }

  const declaration = await readDeclaration(request.checkout, request.operation.kind);
  const platform = declaredPlatform();
  if (!declaration.platforms.includes(platform)) {
    throw new Error(`The declared operation does not support platform ${platform}.`);
  }
  const inspection = await taskCli.inspect({
    checkout: request.checkout,
    timeoutMs: Math.min(request.timeoutMs, 5_000),
  });
  const taskfile = resolve(inspection.taskfile);
  if (
    !taskfileNames.has(basename(taskfile)) ||
    !samePath(resolve(request.checkout), resolve(taskfile, "..")) ||
    !(await stat(taskfile).catch(() => undefined))?.isFile()
  ) {
    throw new Error("Task CLI did not resolve a supported root Target Project Taskfile.");
  }
  if (!inspection.tasks.includes(declaration.task)) {
    throw new Error("The declared Task task is not public or available.");
  }
  return {
    task: declaration.task,
    artifacts: declaration.artifacts,
    discovery: {
      status: "verified",
      checkout: { path: request.checkout, status: "verified" },
      platform: { name: platform, status: "verified" },
      taskCli: { version: inspection.version, status: "verified" },
      taskfile: { path: taskfile, status: "verified" },
      operation: { semantic: request.operation.kind, task: declaration.task, status: "verified" },
    },
  };
}

async function readDeclaration(
  checkout: string,
  operation: "test",
): Promise<OperationDeclaration> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(checkout, "cmd-riker.operations.json"), "utf8"));
  } catch {
    throw new Error("Target Project operation declaration is missing or invalid.");
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.operations)) {
    throw new Error("Target Project operation declaration must use version 1.");
  }
  const declared = value.operations[operation];
  if (
    !isRecord(declared) ||
    typeof declared.task !== "string" ||
    !declared.task.trim() ||
    !/^[A-Za-z0-9_][A-Za-z0-9_:-]*$/.test(declared.task) ||
    !Array.isArray(declared.platforms) ||
    !declared.platforms.every(isDeclaredPlatform) ||
    !Array.isArray(declared.artifacts) ||
    declared.artifacts.length > 32 ||
    !declared.artifacts.every((artifact) => typeof artifact === "string" && artifact.length > 0)
  ) {
    throw new Error(`Target Project operation ${operation} is not declared correctly.`);
  }
  for (const artifact of declared.artifacts) {
    if (isAbsolute(artifact) || !isWithin(checkout, join(checkout, artifact))) {
      throw new Error("Declared operation artifacts must remain inside the checkout.");
    }
    const observed = await lstat(join(checkout, artifact)).catch(() => undefined);
    if (observed?.isDirectory() || (observed?.isFile() && observed.size > 16 * 1024 * 1024)) {
      throw new Error("Declared artifacts must be files no larger than 16 MiB.");
    }
  }
  return {
    task: declared.task,
    platforms: declared.platforms,
    artifacts: declared.artifacts,
  };
}

async function observeArtifacts(checkout: string, artifacts: string[]): Promise<Map<string, string>> {
  const observations = new Map<string, string>();
  for (const artifact of artifacts) {
    const digest = await artifactDigest(join(checkout, artifact));
    if (digest !== null) observations.set(artifact, digest);
  }
  return observations;
}

async function artifactDigest(path: string): Promise<string | null> {
  const observed = await lstat(path).catch(() => undefined);
  if (!observed) return null;
  const hash = createHash("sha256");
  if (observed.isFile()) {
    if (observed.size > 16 * 1024 * 1024) {
      throw new Error("Declared artifact exceeds the 16 MiB integrity-observation limit.");
    }
    hash.update("file\0");
    hash.update(await readFile(path));
    return hash.digest("hex");
  }
  if (observed.isDirectory()) {
    throw new Error("Declared artifacts must be bounded files, not directories.");
  }
  hash.update(`other\0${observed.mode}\0${observed.size}`);
  return hash.digest("hex");
}

// Node refuses to start .cmd/.bat shims directly (EINVAL), and a bare command name
// only resolves to an .exe. npm-installed CLIs (e.g. go-task via @go-task/cli) exist
// solely as .cmd shims on PATH, so route those through ComSpec with a verbatim
// command line; everything else runs unchanged.
function resolveInvocation(
  executable: string,
  args: string[],
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (process.platform !== "win32") return { file: executable, args, windowsVerbatimArguments: false };
  const resolved = resolveWindowsExecutable(executable);
  if (!/\.(cmd|bat)$/i.test(resolved)) {
    return { file: resolved, args, windowsVerbatimArguments: false };
  }
  const quote = (value: string) => (/[\s"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  const commandLine = [quote(resolved), ...args.map(quote)].join(" ");
  return {
    file: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function resolveWindowsExecutable(executable: string): string {
  if (/[\\/]/.test(executable) || /\.[a-z0-9]+$/i.test(executable)) return executable;
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(";")) {
    if (!directory) continue;
    for (const extension of [".exe", ".com", ".cmd", ".bat"]) {
      const candidate = join(directory, executable + extension);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // Unreadable PATH entries must not abort resolution.
      }
    }
  }
  return executable;
}

function execute(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const invocation = resolveInvocation(executable, args);
  return new Promise((resolveExecution, reject) => {
    execFile(
      invocation.file,
      invocation.args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        maxBuffer: 256 * 1024,
        env: safeChildEnvironment(),
      },
      (error, stdout, stderr) => {
        const code = error ? (error as { code?: unknown }).code : undefined;
        const killed = Boolean(error && "killed" in error && error.killed);
        if (error && typeof code !== "number" && !killed) {
          reject(error);
          return;
        }
        resolveExecution({
          exitCode: typeof code === "number" ? code : error ? 1 : 0,
          stdout,
          stderr,
          timedOut: killed,
        });
      },
    );
  });
}

function executeTask(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; timedOut: boolean; outputTail: string }> {
  const invocation = resolveInvocation(executable, args);
  return new Promise((resolveExecution, reject) => {
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
      env: safeChildEnvironment(),
    });
    // A failed run whose output is discarded cannot be diagnosed from the durable
    // record, so keep a bounded tail of the combined output.
    const outputTailLimit = 8 * 1024;
    let outputTail = "";
    const observeOutput = (chunk: Buffer) => {
      outputTail = (outputTail + chunk.toString("utf8")).slice(-outputTailLimit);
    };
    child.stdout?.on("data", observeOutput);
    child.stderr?.on("data", observeOutput);
    let timedOut = false;
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;
    let hardStop: NodeJS.Timeout | undefined;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (hardStop) clearTimeout(hardStop);
      resolveExecution({ exitCode, timedOut, outputTail });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateTaskProcess(child.pid, false);
      escalation = setTimeout(() => terminateTaskProcess(child.pid, true), 1_000);
      hardStop = setTimeout(() => finish(1), 2_000);
    }, timeoutMs);
    child.once("error", (error) => {
      if (timedOut) finish(1);
      else {
        clearTimeout(timeout);
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      finish(code ?? 1);
    });
  });
}

function terminateTaskProcess(pid: number | undefined, force: boolean): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])];
    const termination = spawn("taskkill", args, {
      windowsHide: true,
      stdio: "ignore",
      env: safeChildEnvironment(),
    });
    termination.on("error", () => undefined);
    return;
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The process may have exited between timeout observation and interruption.
  }
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === "win32"
    ? [
        "ALLUSERSPROFILE",
        "APPDATA",
        "CommonProgramFiles",
        "CommonProgramFiles(x86)",
        "CommonProgramW6432",
        "ComSpec",
        "LOCALAPPDATA",
        "NUMBER_OF_PROCESSORS",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        // MSBuild/NuGet resolve SDK fallback folders from the ProgramFiles/ProgramData
        // family; without them `dotnet test` dies with "Value cannot be null (path1)".
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
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

function isTaskList(value: unknown): value is {
  location: string;
  tasks: Array<{ name: string }>;
} {
  return (
    isRecord(value) &&
    typeof value.location === "string" &&
    Array.isArray(value.tasks) &&
    value.tasks.every((task) => isRecord(task) && typeof task.name === "string")
  );
}

function declaredPlatform(): DeclaredPlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

function isDeclaredPlatform(value: unknown): value is DeclaredPlatform {
  return value === "windows" || value === "linux" || value === "darwin";
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function normalizedAuthorizedWriteRoot(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
