import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import type { Commitment } from "../orchestration-core/index.ts";
import type {
  ExternalEffectEvidence,
  ForgeOperationEffectIntent,
} from "../target-project-operations/index.ts";

export type ForgeProvider = "github" | "azure";

export type ForgeOperationRequest =
  | {
      commitmentId: string;
      operation: {
        kind: "github-issue-comment";
        repository: string;
        issueNumber: number;
        body: string;
        expectedAccount: string;
      };
      timeoutMs: number;
      actingAuthorityEffectAuthorization?: {
        actingAuthorityId: string;
        authorizationId: string;
        standingOrderId: string;
      };
    }
  | {
      commitmentId: string;
      operation: {
        kind: "azure-subscription-inspection";
        subscriptionId: string;
        expectedAccount: string;
      };
      timeoutMs: number;
    };

export type ForgeOperationStatus =
  | "succeeded"
  | "failed"
  | "timed-out"
  | "unknown"
  | "rejected"
  | "unavailable";

export type ForgeOperationTarget =
  | {
      kind: "github-issue";
      repository: string;
      issueNumber: number;
      bodySha256: string;
    }
  | {
      kind: "azure-subscription";
      subscriptionId: string;
    };

export type ForgeCapabilityProof = {
  provider: ForgeProvider;
  executable: string;
  version: string;
  authentication: "verified";
  account: string;
  target: string;
  capability: string;
  observedAt: string;
};

export type ForgeOwnerActionNotice = {
  id: "github-cli" | "azure-cli";
  provider: ForgeProvider;
  state: "active" | "cleared";
  fingerprint: string;
  detail: string;
  nextAction: string;
  expectedAccount: string;
  target: string;
  observedAt: string;
};

export type ForgeOperationResult = {
  operationAttemptId: string;
  effectIntentId?: string;
  commitmentId: string;
  operation: ForgeOperationRequest["operation"]["kind"];
  provider: ForgeProvider;
  status: ForgeOperationStatus;
  capability?: ForgeCapabilityProof;
  evidence: ExternalEffectEvidence[];
  diagnostics: Array<{
    source: "gh-cli" | "az-cli" | "host";
    message: string;
  }>;
  uncertainty: null | { reason: string; nextAction: string };
  ownerAction?: {
    id: ForgeOwnerActionNotice["id"];
    disposition: "recorded" | "deduplicated";
    nextAction: string;
  };
  startedAt: string;
  completedAt: string;
};

export type ForgeOperationAttempt = {
  id: string;
  commitmentId: string;
  effectIntentId?: string;
  provider: ForgeProvider;
  operation: ForgeOperationRequest["operation"]["kind"];
  target: ForgeOperationTarget;
  expectedAccount: string;
  timeoutMs: number;
  status: "ready" | "running" | ForgeOperationStatus;
  startedAt: string;
  result?: ForgeOperationResult;
};

export interface GitHubCli {
  inspect(input: {
    repository: string;
    expectedAccount: string;
    timeoutMs: number;
  }): Promise<ForgeCapabilityProof>;
  createIssueComment(input: {
    repository: string;
    issueNumber: number;
    body: string;
    timeoutMs: number;
  }): Promise<{ id: string; url: string }>;
  readIssueComment(input: {
    repository: string;
    commentId: string;
    timeoutMs: number;
  }): Promise<{ id: string; url: string; body: string; author: string; observedAt: string }>;
}

export interface AzureCli {
  inspectSubscription(input: {
    subscriptionId: string;
    expectedAccount: string;
    timeoutMs: number;
  }): Promise<{
    capability: ForgeCapabilityProof;
    evidence: ExternalEffectEvidence;
  }>;
}

export interface ForgeOperationState {
  readCommitment(commitmentId: string): Commitment | undefined;
  appendForgeOperationAttemptSnapshots(snapshots: ForgeOperationAttempt[]): void;
  startForgeMutation(
    attempt: ForgeOperationAttempt,
    effectIntent: ForgeOperationEffectIntent,
  ): void;
  claimForgeMutation(
    attempt: ForgeOperationAttempt,
    effectIntent: ForgeOperationEffectIntent,
  ): void;
  settleForgeMutation(
    attempt: ForgeOperationAttempt,
    effectIntent: ForgeOperationEffectIntent,
  ): void;
  readForgeOwnerActionNotice(id: ForgeOwnerActionNotice["id"]): ForgeOwnerActionNotice | undefined;
  readForgeOwnerActionNotices(): ForgeOwnerActionNotice[];
  appendForgeOwnerActionNotice(notice: ForgeOwnerActionNotice): void;
}

export interface ForgeOperations {
  execute(request: ForgeOperationRequest): Promise<ForgeOperationResult>;
}

export function createForgeOperations(
  state: ForgeOperationState,
  adapters: { github?: GitHubCli; azure?: AzureCli } = {},
): ForgeOperations {
  const github = adapters.github ?? new NativeGitHubCli();
  const azure = adapters.azure ?? new NativeAzureCli();
  return {
    async execute(request) {
      assertRequest(request);
      const commitment = state.readCommitment(request.commitmentId);
      if (!commitment || commitment.state !== "active" || commitment.condition) {
        throw new Error("Forge operations require one unblocked active Commitment.");
      }
      if (
        commitment.criteria.length === 0 ||
        commitment.criteria.some(
          (criterion) =>
            criterion.kind !== "forge-operation" ||
            criterion.operation !== request.operation.kind,
        )
      ) {
        throw new Error("The active Commitment must declare the exact Forge operation as its objective criterion.");
      }
      if (request.operation.kind === "github-issue-comment") {
        return executeGitHubMutation(
          state,
          github,
          request as Extract<ForgeOperationRequest, { operation: { kind: "github-issue-comment" } }>,
        );
      }
      return executeAzureInspection(
        state,
        azure,
        request as Extract<ForgeOperationRequest, { operation: { kind: "azure-subscription-inspection" } }>,
      );
    },
  };
}

export class ForgeAdapterError extends Error {
  readonly kind: "unavailable" | "authentication" | "identity" | "target" | "capability" | "interactive";

  constructor(
    kind: "unavailable" | "authentication" | "identity" | "target" | "capability" | "interactive",
    message: string,
  ) {
    super(message);
    this.name = "ForgeAdapterError";
    this.kind = kind;
  }
}

export class NativeGitHubCli implements GitHubCli {
  private readonly executable: string;

  constructor(executable = "gh") {
    this.executable = executable;
  }

  async inspect(input: {
    repository: string;
    expectedAccount: string;
    timeoutMs: number;
  }): Promise<ForgeCapabilityProof> {
    const version = await runCli(this.executable, ["--version"], input.timeoutMs, "github");
    if (version.exitCode !== 0 || !version.stdout.trim()) {
      throw new ForgeAdapterError("unavailable", "GitHub CLI is unavailable or did not report a version.");
    }
    const identity = await runCli(
      this.executable,
      ["api", "user", "--jq", ".login"],
      input.timeoutMs,
      "github",
    );
    if (identity.exitCode !== 0 || !identity.stdout.trim()) {
      throw new ForgeAdapterError("authentication", "GitHub CLI authentication is unavailable.");
    }
    const account = identity.stdout.trim();
    if (account.toLowerCase() !== input.expectedAccount.toLowerCase()) {
      throw new ForgeAdapterError("identity", "GitHub CLI is authenticated as a different account.");
    }
    const target = await runCli(
      this.executable,
      ["repo", "view", input.repository, "--json", "nameWithOwner,viewerPermission"],
      input.timeoutMs,
      "github",
    );
    if (target.exitCode !== 0) {
      throw new ForgeAdapterError("target", "The intended GitHub repository is unavailable to the authenticated account.");
    }
    const parsed = parseJson(target.stdout, "GitHub repository capability response") as {
      nameWithOwner?: unknown;
      viewerPermission?: unknown;
    };
    if (
      typeof parsed.nameWithOwner !== "string" ||
      parsed.nameWithOwner.toLowerCase() !== input.repository.toLowerCase()
    ) {
      throw new ForgeAdapterError("target", "GitHub CLI resolved a different repository target.");
    }
    const permission = typeof parsed.viewerPermission === "string" ? parsed.viewerPermission : "";
    if (!new Set(["ADMIN", "MAINTAIN", "WRITE"]).has(permission)) {
      throw new ForgeAdapterError("capability", "The authenticated GitHub account cannot write issue comments in the target repository.");
    }
    return {
      provider: "github",
      executable: this.executable,
      version: version.stdout.split(/\r?\n/, 1)[0]!.trim(),
      authentication: "verified",
      account,
      target: parsed.nameWithOwner,
      capability: `issue-comment:${permission}`,
      observedAt: new Date().toISOString(),
    };
  }

  async createIssueComment(input: {
    repository: string;
    issueNumber: number;
    body: string;
    timeoutMs: number;
  }): Promise<{ id: string; url: string }> {
    const result = await runCli(
      this.executable,
      [
        "api",
        `repos/${input.repository}/issues/${input.issueNumber}/comments`,
        "--method",
        "POST",
        "--raw-field",
        `body=${input.body}`,
        "--jq",
        "{id: (.id|tostring), url: .html_url}",
      ],
      input.timeoutMs,
      "github",
    );
    if (result.exitCode !== 0) {
      throw new ForgeAdapterError("capability", "GitHub issue comment dispatch did not return a successful response.");
    }
    const parsed = parseJson(result.stdout, "GitHub mutation response") as { id?: unknown; url?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.url !== "string") {
      throw new ForgeAdapterError("capability", "GitHub mutation response omitted its remote identity.");
    }
    return { id: parsed.id, url: parsed.url };
  }

  async readIssueComment(input: {
    repository: string;
    commentId: string;
    timeoutMs: number;
  }): Promise<{ id: string; url: string; body: string; author: string; observedAt: string }> {
    const result = await runCli(
      this.executable,
      [
        "api",
        `repos/${input.repository}/issues/comments/${input.commentId}`,
        "--jq",
        "{id: (.id|tostring), url: .html_url, body: .body, author: .user.login, observedAt: .updated_at}",
      ],
      input.timeoutMs,
      "github",
    );
    if (result.exitCode !== 0) {
      throw new ForgeAdapterError("capability", "GitHub issue comment read-back was unavailable.");
    }
    const parsed = parseJson(result.stdout, "GitHub read-back response") as Record<string, unknown>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.url !== "string" ||
      typeof parsed.body !== "string" ||
      typeof parsed.author !== "string" ||
      typeof parsed.observedAt !== "string"
    ) {
      throw new ForgeAdapterError("capability", "GitHub read-back response was incomplete.");
    }
    return parsed as { id: string; url: string; body: string; author: string; observedAt: string };
  }
}

export class NativeAzureCli implements AzureCli {
  private readonly executable: string;

  constructor(executable = "az") {
    this.executable = executable;
  }

  async inspectSubscription(input: {
    subscriptionId: string;
    expectedAccount: string;
    timeoutMs: number;
  }): Promise<{ capability: ForgeCapabilityProof; evidence: ExternalEffectEvidence }> {
    const version = await runCli(
      this.executable,
      ["version", "--output", "json"],
      input.timeoutMs,
      "azure",
    );
    if (version.exitCode !== 0) {
      throw new ForgeAdapterError("unavailable", "Azure CLI is unavailable or did not report a version.");
    }
    const versions = parseJson(version.stdout, "Azure CLI version response") as Record<string, unknown>;
    const cliVersion = versions["azure-cli"];
    if (typeof cliVersion !== "string") {
      throw new ForgeAdapterError("unavailable", "Azure CLI version response was incomplete.");
    }
    const inspection = await runCli(
      this.executable,
      [
        "account",
        "show",
        "--subscription",
        input.subscriptionId,
        "--output",
        "json",
        "--only-show-errors",
      ],
      input.timeoutMs,
      "azure",
    );
    if (inspection.exitCode !== 0) {
      throw new ForgeAdapterError("authentication", "Azure CLI authentication or subscription access is unavailable.");
    }
    const account = parseJson(inspection.stdout, "Azure subscription inspection") as {
      id?: unknown;
      name?: unknown;
      state?: unknown;
      tenantId?: unknown;
      user?: { name?: unknown };
    };
    if (typeof account.id !== "string" || account.id.toLowerCase() !== input.subscriptionId.toLowerCase()) {
      throw new ForgeAdapterError("target", "Azure CLI resolved a different subscription target.");
    }
    const accountName = account.user?.name;
    if (typeof accountName !== "string") {
      throw new ForgeAdapterError("authentication", "Azure CLI did not identify its authenticated account.");
    }
    if (accountName.toLowerCase() !== input.expectedAccount.toLowerCase()) {
      throw new ForgeAdapterError("identity", "Azure CLI is authenticated as a different account.");
    }
    if (account.state !== "Enabled") {
      throw new ForgeAdapterError("capability", "The intended Azure subscription is not enabled.");
    }
    const observedAt = new Date().toISOString();
    return {
      capability: {
        provider: "azure",
        executable: this.executable,
        version: cliVersion,
        authentication: "verified",
        account: accountName,
        target: account.id,
        capability: "subscription-inspection",
        observedAt,
      },
      evidence: {
        source: "provider-readback",
        reference: `azure-subscription:${account.id}`,
        summary: `Azure subscription ${String(account.name ?? account.id)} is enabled for the intended account.`,
        observedAt,
      },
    };
  }
}

async function executeGitHubMutation(
  state: ForgeOperationState,
  github: GitHubCli,
  request: Extract<ForgeOperationRequest, { operation: { kind: "github-issue-comment" } }>,
): Promise<ForgeOperationResult> {
  const operationAttemptId = randomUUID();
  const effectIntentId = randomUUID();
  const startedAt = new Date().toISOString();
  const bodySha256 = sha256(request.operation.body);
  const target: ForgeOperationTarget = {
    kind: "github-issue",
    repository: request.operation.repository,
    issueNumber: request.operation.issueNumber,
    bodySha256,
  };
  let capability: ForgeCapabilityProof;
  try {
    capability = await github.inspect({
      repository: request.operation.repository,
      expectedAccount: request.operation.expectedAccount,
      timeoutMs: request.timeoutMs,
    });
  } catch (error) {
    return recordPreflightFailure(state, {
      operationAttemptId,
      commitmentId: request.commitmentId,
      operation: request.operation.kind,
      provider: "github",
      target,
      expectedAccount: request.operation.expectedAccount,
      timeoutMs: request.timeoutMs,
      startedAt,
      error,
    });
  }
  clearOwnerAction(state, "github-cli", capability, request.operation.expectedAccount);
  const attempt: ForgeOperationAttempt = {
    id: operationAttemptId,
    commitmentId: request.commitmentId,
    effectIntentId,
    provider: "github",
    operation: request.operation.kind,
    target,
    expectedAccount: request.operation.expectedAccount,
    timeoutMs: request.timeoutMs,
    status: "ready",
    startedAt,
  };
  const effectIntent: ForgeOperationEffectIntent = {
    id: effectIntentId,
    commitmentId: request.commitmentId,
    kind: "forge-operation",
    forgeOperationAttemptId: operationAttemptId,
    provider: "github",
    effectScopeKey: `github:${request.operation.repository.toLowerCase()}:issue:${request.operation.issueNumber}`,
    expectedEffect: `Create one attributed GitHub issue comment with body SHA-256 ${bodySha256}.`,
    authorization: {
      kind: "lead-agent-command-authority",
      commitmentId: request.commitmentId,
      targetProjectPath: request.operation.repository,
      validatedAt: startedAt,
      ...(request.actingAuthorityEffectAuthorization
        ? { actingAuthority: request.actingAuthorityEffectAuthorization }
        : {}),
    },
    retryRule: "Read back the exact remote comment identity before any retry.",
    status: "pending",
  };
  state.startForgeMutation(attempt, effectIntent);
  const claimedAt = new Date().toISOString();
  const runningAttempt: ForgeOperationAttempt = { ...attempt, status: "running" };
  const dispatchingEffect: ForgeOperationEffectIntent = {
    ...effectIntent,
    status: "dispatching",
    lease: {
      claimedAt,
      expiresAt: new Date(Date.now() + request.timeoutMs).toISOString(),
    },
  };
  state.claimForgeMutation(runningAttempt, dispatchingEffect);

  let created: Awaited<ReturnType<GitHubCli["createIssueComment"]>>;
  try {
    created = await github.createIssueComment({
      repository: request.operation.repository,
      issueNumber: request.operation.issueNumber,
      body: request.operation.body,
      timeoutMs: request.timeoutMs,
    });
  } catch {
    return settleUnknownGitHubMutation(
      state,
      runningAttempt,
      dispatchingEffect,
      capability,
      "GitHub mutation continuity was lost after dispatch.",
    );
  }

  let readback: Awaited<ReturnType<GitHubCli["readIssueComment"]>>;
  try {
    readback = await github.readIssueComment({
      repository: request.operation.repository,
      commentId: created.id,
      timeoutMs: request.timeoutMs,
    });
  } catch {
    return settleUnknownGitHubMutation(
      state,
      runningAttempt,
      dispatchingEffect,
      capability,
      "GitHub mutation completed without an authoritative read-back.",
    );
  }
  const verified =
    readback.id === created.id &&
    readback.url === created.url &&
    sha256(readback.body) === bodySha256 &&
    readback.author.toLowerCase() === request.operation.expectedAccount.toLowerCase();
  if (!verified) {
    return settleUnknownGitHubMutation(
      state,
      runningAttempt,
      dispatchingEffect,
      capability,
      "GitHub read-back did not match the intended account, remote identity, and content digest.",
    );
  }
  const result: ForgeOperationResult = {
    operationAttemptId,
    effectIntentId,
    commitmentId: request.commitmentId,
    operation: request.operation.kind,
    provider: "github",
    status: "succeeded",
    capability,
    evidence: [{
      source: "provider-readback",
      reference: readback.url,
      summary: `GitHub comment ${readback.id} matched the intended account and content digest.`,
      observedAt: readback.observedAt,
    }],
    diagnostics: [{ source: "gh-cli", message: "GitHub issue comment was verified by remote read-back." }],
    uncertainty: null,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  state.settleForgeMutation(
    { ...runningAttempt, status: "succeeded", result },
    { ...dispatchingEffect, status: "succeeded" },
  );
  return result;
}

async function executeAzureInspection(
  state: ForgeOperationState,
  azure: AzureCli,
  request: Extract<ForgeOperationRequest, { operation: { kind: "azure-subscription-inspection" } }>,
): Promise<ForgeOperationResult> {
  const operationAttemptId = randomUUID();
  const startedAt = new Date().toISOString();
  const target: ForgeOperationTarget = {
    kind: "azure-subscription",
    subscriptionId: request.operation.subscriptionId,
  };
  try {
    const inspected = await azure.inspectSubscription({
      subscriptionId: request.operation.subscriptionId,
      expectedAccount: request.operation.expectedAccount,
      timeoutMs: request.timeoutMs,
    });
    clearOwnerAction(state, "azure-cli", inspected.capability, request.operation.expectedAccount);
    const result: ForgeOperationResult = {
      operationAttemptId,
      commitmentId: request.commitmentId,
      operation: request.operation.kind,
      provider: "azure",
      status: "succeeded",
      capability: inspected.capability,
      evidence: [inspected.evidence],
      diagnostics: [{ source: "az-cli", message: "Azure subscription inspection completed." }],
      uncertainty: null,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    state.appendForgeOperationAttemptSnapshots([{
      id: operationAttemptId,
      commitmentId: request.commitmentId,
      provider: "azure",
      operation: request.operation.kind,
      target,
      expectedAccount: request.operation.expectedAccount,
      timeoutMs: request.timeoutMs,
      status: "succeeded",
      startedAt,
      result,
    }]);
    return result;
  } catch (error) {
    return recordPreflightFailure(state, {
      operationAttemptId,
      commitmentId: request.commitmentId,
      operation: request.operation.kind,
      provider: "azure",
      target,
      expectedAccount: request.operation.expectedAccount,
      timeoutMs: request.timeoutMs,
      startedAt,
      error,
    });
  }
}

function recordPreflightFailure(
  state: ForgeOperationState,
  input: {
    operationAttemptId: string;
    commitmentId: string;
    operation: ForgeOperationResult["operation"];
    provider: ForgeProvider;
    target: ForgeOperationTarget;
    expectedAccount: string;
    timeoutMs: number;
    startedAt: string;
    error: unknown;
  },
): ForgeOperationResult {
  const failure = classifyPreflightError(input.provider, input.error);
  const action = recordOwnerAction(state, {
    provider: input.provider,
    detail: failure.detail,
    nextAction: failure.nextAction,
    expectedAccount: input.expectedAccount,
    target: targetLabel(input.target),
  });
  const result: ForgeOperationResult = {
    operationAttemptId: input.operationAttemptId,
    commitmentId: input.commitmentId,
    operation: input.operation,
    provider: input.provider,
    status: failure.status,
    evidence: [],
    diagnostics: [{ source: input.provider === "github" ? "gh-cli" : "az-cli", message: failure.detail }],
    uncertainty: null,
    ownerAction: action,
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
  };
  state.appendForgeOperationAttemptSnapshots([{
    id: input.operationAttemptId,
    commitmentId: input.commitmentId,
    provider: input.provider,
    operation: input.operation,
    target: input.target,
    expectedAccount: input.expectedAccount,
    timeoutMs: input.timeoutMs,
    status: failure.status,
    startedAt: input.startedAt,
    result,
  }]);
  return result;
}

function settleUnknownGitHubMutation(
  state: ForgeOperationState,
  attempt: ForgeOperationAttempt,
  effectIntent: ForgeOperationEffectIntent,
  capability: ForgeCapabilityProof,
  reason: string,
): ForgeOperationResult {
  const result: ForgeOperationResult = {
    operationAttemptId: attempt.id,
    effectIntentId: effectIntent.id,
    commitmentId: attempt.commitmentId,
    operation: attempt.operation,
    provider: "github",
    status: "unknown",
    capability,
    evidence: [],
    diagnostics: [{ source: "gh-cli", message: reason }],
    uncertainty: {
      reason,
      nextAction: "Inspect the target issue for the exact content digest before any retry.",
    },
    startedAt: attempt.startedAt,
    completedAt: new Date().toISOString(),
  };
  state.settleForgeMutation(
    { ...attempt, status: "unknown", result },
    { ...effectIntent, status: "unknown" },
  );
  return result;
}

function recordOwnerAction(
  state: ForgeOperationState,
  input: Omit<ForgeOwnerActionNotice, "id" | "state" | "fingerprint" | "observedAt">,
): NonNullable<ForgeOperationResult["ownerAction"]> {
  const id = input.provider === "github" ? "github-cli" : "azure-cli";
  const fingerprint = sha256([
    input.provider,
    input.detail,
    input.nextAction,
    input.expectedAccount,
    input.target,
  ].join("|"));
  const current = state.readForgeOwnerActionNotice(id);
  if (current?.state === "active" && current.fingerprint === fingerprint) {
    return { id, disposition: "deduplicated", nextAction: current.nextAction };
  }
  const notice: ForgeOwnerActionNotice = {
    id,
    provider: input.provider,
    state: "active",
    fingerprint,
    detail: input.detail,
    nextAction: input.nextAction,
    expectedAccount: input.expectedAccount,
    target: input.target,
    observedAt: new Date().toISOString(),
  };
  state.appendForgeOwnerActionNotice(notice);
  return { id, disposition: "recorded", nextAction: notice.nextAction };
}

function clearOwnerAction(
  state: ForgeOperationState,
  id: ForgeOwnerActionNotice["id"],
  capability: ForgeCapabilityProof,
  expectedAccount: string,
): void {
  const current = state.readForgeOwnerActionNotice(id);
  if (!current || current.state === "cleared") return;
  state.appendForgeOwnerActionNotice({
    ...current,
    state: "cleared",
    detail: `${capability.provider} capability was proven available for the intended account and target.`,
    expectedAccount,
    target: capability.target,
    observedAt: capability.observedAt,
  });
}

function classifyPreflightError(
  provider: ForgeProvider,
  error: unknown,
): { status: "rejected" | "unavailable"; detail: string; nextAction: string } {
  const kind = error instanceof ForgeAdapterError ? error.kind : "unavailable";
  const detail = error instanceof ForgeAdapterError
    ? error.message
    : `${provider === "github" ? "GitHub" : "Azure"} CLI capability probe failed.`;
  const executable = provider === "github" ? "gh" : "az";
  const nextAction = kind === "unavailable"
    ? `Install ${executable} and make it available on PATH, then retry the inspection.`
    : kind === "authentication"
      ? `Authenticate ${executable} outside CMD Riker for the intended account, then retry.`
      : kind === "interactive"
        ? `Complete the required ${executable} interaction outside CMD Riker, then retry.`
        : `Correct the intended ${provider} account, target, or capability outside CMD Riker, then retry.`;
  return {
    status: kind === "unavailable" || kind === "authentication" || kind === "interactive"
      ? "unavailable"
      : "rejected",
    detail,
    nextAction,
  };
}

function assertRequest(request: ForgeOperationRequest): void {
  if (!request.commitmentId.trim() || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new Error("Forge operations require a Commitment identity and positive timeout.");
  }
  if (!request.operation.expectedAccount.trim()) {
    throw new Error("Forge operations require the intended account identity.");
  }
  if (request.operation.kind === "github-issue-comment") {
    if (
      !/^[^/\s]+\/[^/\s]+$/.test(request.operation.repository) ||
      !Number.isInteger(request.operation.issueNumber) ||
      request.operation.issueNumber < 1 ||
      !request.operation.body.trim() ||
      Buffer.byteLength(request.operation.body, "utf8") > 64 * 1024
    ) {
      throw new Error("GitHub issue comments require a repository, issue number, and bounded body.");
    }
    return;
  }
  if (!/^[0-9a-f-]{36}$/i.test(request.operation.subscriptionId)) {
    throw new Error("Azure inspection requires one subscription UUID.");
  }
}

function targetLabel(target: ForgeOperationTarget): string {
  return target.kind === "github-issue"
    ? `${target.repository}#${target.issueNumber}`
    : `subscription:${target.subscriptionId}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ForgeAdapterError("capability", `${label} was not valid JSON.`);
  }
}

async function runCli(
  executable: string,
  args: string[],
  timeoutMs: number,
  provider: ForgeProvider,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GH_PAGER: "cat",
        AZURE_CORE_NO_COLOR: "1",
        AZURE_CORE_ONLY_SHOW_ERRORS: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = boundedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = boundedAppend(stderr, chunk);
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new ForgeAdapterError("interactive", `${provider === "github" ? "GitHub" : "Azure"} CLI exceeded its non-interactive deadline.`));
    }, timeoutMs);
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ForgeAdapterError("unavailable", `${provider === "github" ? "GitHub" : "Azure"} CLI executable is unavailable.`));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function boundedAppend(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= 1024 * 1024 ? next : next.slice(0, 1024 * 1024);
}
