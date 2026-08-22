import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import type { Commitment, OwnerConfiguration } from "../orchestration-core/index.ts";
import type {
  ExternalEffectEvidence,
  ForgeOperationEffectIntent,
} from "../target-project-operations/index.ts";

export type ForgeProvider = "github" | "azure";

export type GitHubIssueCloseReason = "completed" | "not-planned";

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
        kind: "github-issue-close";
        repository: string;
        issueNumber: number;
        stateReason: GitHubIssueCloseReason;
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
        kind: "github-issue-label-remove";
        repository: string;
        issueNumber: number;
        label: string;
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

export type GitHubMutationRequest = Exclude<
  ForgeOperationRequest,
  { operation: { kind: "azure-subscription-inspection" } }
>;

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
      kind: "github-issue-state";
      repository: string;
      issueNumber: number;
      state: "closed";
      stateReason: GitHubIssueCloseReason;
    }
  | {
      kind: "github-issue-label";
      repository: string;
      issueNumber: number;
      label: string;
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
  id: string;
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
  capability?: ForgeCapabilityProof;
  status: "ready" | "running" | ForgeOperationStatus;
  startedAt: string;
  result?: ForgeOperationResult;
};

export interface GitHubCli {
  inspect(input: {
    repository: string;
    issueNumber: number;
    expectedAccount: string;
    capability: string;
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
  closeIssue(input: {
    repository: string;
    issueNumber: number;
    stateReason: GitHubIssueCloseReason;
    timeoutMs: number;
  }): Promise<{ url: string }>;
  readIssueState(input: {
    repository: string;
    issueNumber: number;
    timeoutMs: number;
  }): Promise<{
    state: string;
    stateReason: string;
    closedBy: string;
    url: string;
    observedAt: string;
  }>;
  removeIssueLabel(input: {
    repository: string;
    issueNumber: number;
    label: string;
    timeoutMs: number;
  }): Promise<void>;
  readIssueLabels(input: {
    repository: string;
    issueNumber: number;
    timeoutMs: number;
  }): Promise<{ labels: string[]; url: string; observedAt: string }>;
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
  readOwnerConversation(): OwnerConfiguration | undefined;
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
      assertConfiguredAuthority(state.readOwnerConversation(), request);
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
      if (request.operation.kind === "azure-subscription-inspection") {
        return executeAzureInspection(
          state,
          azure,
          request as Extract<ForgeOperationRequest, { operation: { kind: "azure-subscription-inspection" } }>,
        );
      }
      return executeGitHubMutation(state, github, request as GitHubMutationRequest);
    },
  };
}

export class ForgeAdapterError extends Error {
  readonly kind: "unavailable" | "authentication" | "identity" | "target" | "capability" | "interactive" | "timeout";

  constructor(
    kind: "unavailable" | "authentication" | "identity" | "target" | "capability" | "interactive" | "timeout",
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
    issueNumber: number;
    expectedAccount: string;
    capability: string;
    timeoutMs: number;
  }): Promise<ForgeCapabilityProof> {
    const deadline = Date.now() + input.timeoutMs;
    const version = await runCli(this.executable, ["--version"], remainingTimeout(deadline), "github");
    if (version.exitCode !== 0 || !version.stdout.trim()) {
      throw new ForgeAdapterError("unavailable", "GitHub CLI is unavailable or did not report a version.");
    }
    const identity = await runCli(
      this.executable,
      ["api", "user", "--jq", ".login"],
      remainingTimeout(deadline),
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
      remainingTimeout(deadline),
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
      throw new ForgeAdapterError("capability", "The authenticated GitHub account cannot write to issues in the target repository.");
    }
    const issue = await runCli(
      this.executable,
      ["api", `repos/${input.repository}/issues/${input.issueNumber}`, "--jq", ".number"],
      remainingTimeout(deadline),
      "github",
    );
    if (issue.exitCode !== 0 || Number(issue.stdout.trim()) !== input.issueNumber) {
      throw new ForgeAdapterError("target", "The intended GitHub issue is unavailable to the authenticated account.");
    }
    return {
      provider: "github",
      executable: this.executable,
      version: version.stdout.split(/\r?\n/, 1)[0]!.trim(),
      authentication: "verified",
      account,
      target: `${parsed.nameWithOwner}#${input.issueNumber}`,
      capability: `${input.capability}:${permission}`,
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

  async closeIssue(input: {
    repository: string;
    issueNumber: number;
    stateReason: GitHubIssueCloseReason;
    timeoutMs: number;
  }): Promise<{ url: string }> {
    const result = await runCli(
      this.executable,
      [
        "api",
        `repos/${input.repository}/issues/${input.issueNumber}`,
        "--method",
        "PATCH",
        "--raw-field",
        "state=closed",
        "--raw-field",
        `state_reason=${input.stateReason.replace("-", "_")}`,
        "--jq",
        "{url: .html_url}",
      ],
      input.timeoutMs,
      "github",
    );
    if (result.exitCode !== 0) {
      throw new ForgeAdapterError("capability", "GitHub issue close dispatch did not return a successful response.");
    }
    const parsed = parseJson(result.stdout, "GitHub mutation response") as { url?: unknown };
    if (typeof parsed.url !== "string") {
      throw new ForgeAdapterError("capability", "GitHub mutation response omitted its remote identity.");
    }
    return { url: parsed.url };
  }

  async readIssueState(input: {
    repository: string;
    issueNumber: number;
    timeoutMs: number;
  }): Promise<{ state: string; stateReason: string; closedBy: string; url: string; observedAt: string }> {
    const result = await runCli(
      this.executable,
      [
        "api",
        `repos/${input.repository}/issues/${input.issueNumber}`,
        "--jq",
        '{state: .state, stateReason: (.state_reason // ""), closedBy: (.closed_by.login // ""), url: .html_url, observedAt: .updated_at}',
      ],
      input.timeoutMs,
      "github",
    );
    if (result.exitCode !== 0) {
      throw new ForgeAdapterError("capability", "GitHub issue state read-back was unavailable.");
    }
    const parsed = parseJson(result.stdout, "GitHub read-back response") as Record<string, unknown>;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.stateReason !== "string" ||
      typeof parsed.closedBy !== "string" ||
      typeof parsed.url !== "string" ||
      typeof parsed.observedAt !== "string"
    ) {
      throw new ForgeAdapterError("capability", "GitHub read-back response was incomplete.");
    }
    return parsed as { state: string; stateReason: string; closedBy: string; url: string; observedAt: string };
  }

  async removeIssueLabel(input: {
    repository: string;
    issueNumber: number;
    label: string;
    timeoutMs: number;
  }): Promise<void> {
    const result = await runCli(
      this.executable,
      [
        "api",
        `repos/${input.repository}/issues/${input.issueNumber}/labels/${encodeURIComponent(input.label)}`,
        "--method",
        "DELETE",
        "--jq",
        "length",
      ],
      input.timeoutMs,
      "github",
    );
    if (result.exitCode !== 0) {
      throw new ForgeAdapterError("capability", "GitHub label removal dispatch did not return a successful response.");
    }
  }

  async readIssueLabels(input: {
    repository: string;
    issueNumber: number;
    timeoutMs: number;
  }): Promise<{ labels: string[]; url: string; observedAt: string }> {
    const result = await runCli(
      this.executable,
      [
        "api",
        `repos/${input.repository}/issues/${input.issueNumber}`,
        "--jq",
        "{labels: [.labels[].name], url: .html_url, observedAt: .updated_at}",
      ],
      input.timeoutMs,
      "github",
    );
    if (result.exitCode !== 0) {
      throw new ForgeAdapterError("capability", "GitHub issue label read-back was unavailable.");
    }
    const parsed = parseJson(result.stdout, "GitHub read-back response") as Record<string, unknown>;
    if (
      !Array.isArray(parsed.labels) ||
      parsed.labels.some((label) => typeof label !== "string") ||
      typeof parsed.url !== "string" ||
      typeof parsed.observedAt !== "string"
    ) {
      throw new ForgeAdapterError("capability", "GitHub read-back response was incomplete.");
    }
    return parsed as { labels: string[]; url: string; observedAt: string };
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
    const deadline = Date.now() + input.timeoutMs;
    const version = await runCli(
      this.executable,
      ["version", "--output", "json"],
      remainingTimeout(deadline),
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
        "list",
        "--all",
        "--output",
        "json",
        "--only-show-errors",
      ],
      remainingTimeout(deadline),
      "azure",
    );
    if (inspection.exitCode !== 0) {
      throw new ForgeAdapterError("authentication", "Azure CLI authentication is unavailable.");
    }
    const accounts = parseJson(inspection.stdout, "Azure subscription inspection");
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new ForgeAdapterError("authentication", "Azure CLI has no authenticated account context.");
    }
    const account = accounts.find((candidate): candidate is {
      id?: unknown;
      name?: unknown;
      state?: unknown;
      tenantId?: unknown;
      user?: { name?: unknown };
    } => Boolean(
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as { id?: unknown }).id === "string" &&
      (candidate as { id: string }).id.toLowerCase() === input.subscriptionId.toLowerCase(),
    ));
    if (!account) {
      throw new ForgeAdapterError("target", "The intended Azure subscription is unavailable to the authenticated account.");
    }
    const subscriptionId = account.id as string;
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
        target: subscriptionId,
        capability: "subscription-inspection",
        observedAt,
      },
      evidence: {
        source: "provider-readback",
        reference: `azure-subscription:${subscriptionId}`,
        summary: `Azure subscription ${String(account.name ?? subscriptionId)} is enabled for the intended account.`,
        observedAt,
      },
    };
  }
}

/** One GitHub mutation's operation-specific steps: how to dispatch it and how
 * to settle it from an authoritative remote read-back. `readBack` returns the
 * attributed evidence, or undefined when the remote fact does not match the
 * intended effect. */
type GitHubMutationSteps = {
  capability: string;
  target: ForgeOperationTarget;
  expectedEffect: string;
  retryRule: string;
  mismatchReason: string;
  dispatch(timeoutMs: number): Promise<void>;
  readBack(timeoutMs: number): Promise<ExternalEffectEvidence | undefined>;
};

function githubCommentSteps(
  github: GitHubCli,
  operation: Extract<GitHubMutationRequest, { operation: { kind: "github-issue-comment" } }>["operation"],
): GitHubMutationSteps {
  const bodySha256 = sha256(operation.body);
  let created: { id: string; url: string } | undefined;
  return {
    capability: "issue-comment",
    target: {
      kind: "github-issue",
      repository: operation.repository,
      issueNumber: operation.issueNumber,
      bodySha256,
    },
    expectedEffect: `Create one attributed GitHub issue comment with body SHA-256 ${bodySha256}.`,
    retryRule: "Read back the exact remote comment identity before any retry.",
    mismatchReason: "GitHub read-back did not match the intended account, remote identity, and content digest.",
    async dispatch(timeoutMs) {
      created = await github.createIssueComment({
        repository: operation.repository,
        issueNumber: operation.issueNumber,
        body: operation.body,
        timeoutMs,
      });
    },
    async readBack(timeoutMs) {
      const readback = await github.readIssueComment({
        repository: operation.repository,
        commentId: created!.id,
        timeoutMs,
      });
      const verified =
        readback.id === created!.id &&
        readback.url === created!.url &&
        sha256(readback.body) === bodySha256 &&
        readback.author.toLowerCase() === operation.expectedAccount.toLowerCase();
      if (!verified) return undefined;
      return {
        source: "provider-readback",
        reference: readback.url,
        summary: `GitHub comment ${readback.id} matched the intended account and content digest.`,
        observedAt: readback.observedAt,
      };
    },
  };
}

function githubCloseSteps(
  github: GitHubCli,
  operation: Extract<GitHubMutationRequest, { operation: { kind: "github-issue-close" } }>["operation"],
): GitHubMutationSteps {
  return {
    capability: "issue-close",
    target: {
      kind: "github-issue-state",
      repository: operation.repository,
      issueNumber: operation.issueNumber,
      state: "closed",
      stateReason: operation.stateReason,
    },
    expectedEffect: `Close GitHub issue ${operation.repository}#${operation.issueNumber} as ${operation.stateReason}.`,
    retryRule: "Read back the remote issue state before any retry.",
    mismatchReason: "GitHub read-back did not show the issue closed by the intended account with the intended reason.",
    async dispatch(timeoutMs) {
      await github.closeIssue({
        repository: operation.repository,
        issueNumber: operation.issueNumber,
        stateReason: operation.stateReason,
        timeoutMs,
      });
    },
    async readBack(timeoutMs) {
      const readback = await github.readIssueState({
        repository: operation.repository,
        issueNumber: operation.issueNumber,
        timeoutMs,
      });
      const verified =
        readback.state === "closed" &&
        readback.stateReason === operation.stateReason.replace("-", "_") &&
        readback.closedBy.toLowerCase() === operation.expectedAccount.toLowerCase();
      if (!verified) return undefined;
      return {
        source: "provider-readback",
        reference: readback.url,
        summary: `GitHub issue ${operation.repository}#${operation.issueNumber} is closed (${operation.stateReason}) by the intended account.`,
        observedAt: readback.observedAt,
      };
    },
  };
}

function githubLabelRemoveSteps(
  github: GitHubCli,
  operation: Extract<GitHubMutationRequest, { operation: { kind: "github-issue-label-remove" } }>["operation"],
): GitHubMutationSteps {
  return {
    capability: "issue-label-remove",
    target: {
      kind: "github-issue-label",
      repository: operation.repository,
      issueNumber: operation.issueNumber,
      label: operation.label,
    },
    expectedEffect: `Remove label "${operation.label}" from GitHub issue ${operation.repository}#${operation.issueNumber}.`,
    retryRule: "Read back the remote issue labels before any retry.",
    mismatchReason: "GitHub read-back still lists the intended label on the issue.",
    async dispatch(timeoutMs) {
      await github.removeIssueLabel({
        repository: operation.repository,
        issueNumber: operation.issueNumber,
        label: operation.label,
        timeoutMs,
      });
    },
    async readBack(timeoutMs) {
      const readback = await github.readIssueLabels({
        repository: operation.repository,
        issueNumber: operation.issueNumber,
        timeoutMs,
      });
      const absent = readback.labels.every(
        (label) => label.toLowerCase() !== operation.label.toLowerCase(),
      );
      if (!absent) return undefined;
      return {
        source: "provider-readback",
        reference: readback.url,
        summary: `GitHub issue ${operation.repository}#${operation.issueNumber} no longer carries label "${operation.label}".`,
        observedAt: readback.observedAt,
      };
    },
  };
}

function githubMutationSteps(github: GitHubCli, request: GitHubMutationRequest): GitHubMutationSteps {
  switch (request.operation.kind) {
    case "github-issue-comment":
      return githubCommentSteps(github, request.operation);
    case "github-issue-close":
      return githubCloseSteps(github, request.operation);
    case "github-issue-label-remove":
      return githubLabelRemoveSteps(github, request.operation);
  }
}

async function executeGitHubMutation(
  state: ForgeOperationState,
  github: GitHubCli,
  request: GitHubMutationRequest,
): Promise<ForgeOperationResult> {
  const deadline = Date.now() + request.timeoutMs;
  const operationAttemptId = randomUUID();
  const effectIntentId = randomUUID();
  const startedAt = new Date().toISOString();
  const steps = githubMutationSteps(github, request);
  const target = steps.target;
  let capability: ForgeCapabilityProof;
  try {
    capability = await github.inspect({
      repository: request.operation.repository,
      issueNumber: request.operation.issueNumber,
      expectedAccount: request.operation.expectedAccount,
      capability: steps.capability,
      timeoutMs: remainingTimeout(deadline),
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
  clearOwnerActions(state, capability);
  const attempt: ForgeOperationAttempt = {
    id: operationAttemptId,
    commitmentId: request.commitmentId,
    effectIntentId,
    provider: "github",
    operation: request.operation.kind,
    target,
    expectedAccount: request.operation.expectedAccount,
    timeoutMs: request.timeoutMs,
    capability,
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
    expectedEffect: steps.expectedEffect,
    authorization: {
      kind: "lead-agent-command-authority",
      commitmentId: request.commitmentId,
      providerTarget: {
        provider: "github",
        resource: `${request.operation.repository}#${request.operation.issueNumber}`,
      },
      validatedAt: startedAt,
      ...(request.actingAuthorityEffectAuthorization
        ? { actingAuthority: request.actingAuthorityEffectAuthorization }
        : {}),
    },
    retryRule: steps.retryRule,
    status: "pending",
  };
  let dispatchTimeout: number;
  try {
    dispatchTimeout = remainingTimeout(deadline);
  } catch {
    return recordUndispatchedGitHubTimeout(state, attempt);
  }
  state.startForgeMutation(attempt, effectIntent);
  const claimedAt = new Date().toISOString();
  const runningAttempt: ForgeOperationAttempt = { ...attempt, status: "running" };
  const dispatchingEffect: ForgeOperationEffectIntent = {
    ...effectIntent,
    status: "dispatching",
    lease: {
      claimedAt,
      expiresAt: new Date(deadline).toISOString(),
    },
  };
  state.claimForgeMutation(runningAttempt, dispatchingEffect);

  try {
    await steps.dispatch(dispatchTimeout);
  } catch {
    return settleUnknownGitHubMutation(
      state,
      runningAttempt,
      dispatchingEffect,
      capability,
      "GitHub mutation continuity was lost after dispatch.",
    );
  }

  let evidence: ExternalEffectEvidence | undefined;
  try {
    evidence = await steps.readBack(remainingTimeout(deadline));
  } catch {
    return settleUnknownGitHubMutation(
      state,
      runningAttempt,
      dispatchingEffect,
      capability,
      "GitHub mutation completed without an authoritative read-back.",
    );
  }
  if (!evidence) {
    return settleUnknownGitHubMutation(
      state,
      runningAttempt,
      dispatchingEffect,
      capability,
      steps.mismatchReason,
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
    evidence: [evidence],
    diagnostics: [{ source: "gh-cli", message: "The GitHub mutation was verified by remote read-back." }],
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
    clearOwnerActions(state, inspected.capability);
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
      capability: inspected.capability,
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
  const action = failure.ownerActionRequired
    ? recordOwnerAction(state, {
        provider: input.provider,
        detail: failure.detail,
        nextAction: failure.nextAction,
        expectedAccount: input.expectedAccount,
        target: targetLabel(input.target),
      })
    : undefined;
  const result: ForgeOperationResult = {
    operationAttemptId: input.operationAttemptId,
    commitmentId: input.commitmentId,
    operation: input.operation,
    provider: input.provider,
    status: failure.status,
    evidence: [],
    diagnostics: [{ source: input.provider === "github" ? "gh-cli" : "az-cli", message: failure.detail }],
    uncertainty: null,
    ...(action ? { ownerAction: action } : {}),
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

function recordUndispatchedGitHubTimeout(
  state: ForgeOperationState,
  attempt: ForgeOperationAttempt,
): ForgeOperationResult {
  const { effectIntentId: _discardedEffectIntentId, ...unattributedAttempt } = attempt;
  const result: ForgeOperationResult = {
    operationAttemptId: attempt.id,
    commitmentId: attempt.commitmentId,
    operation: attempt.operation,
    provider: "github",
    status: "timed-out",
    ...(attempt.capability ? { capability: attempt.capability } : {}),
    evidence: [],
    diagnostics: [{ source: "gh-cli", message: "The operation deadline expired before mutation dispatch." }],
    uncertainty: null,
    startedAt: attempt.startedAt,
    completedAt: new Date().toISOString(),
  };
  state.appendForgeOperationAttemptSnapshots([{
    ...unattributedAttempt,
    status: "timed-out",
    result,
  }]);
  return result;
}

function recordOwnerAction(
  state: ForgeOperationState,
  input: Omit<ForgeOwnerActionNotice, "id" | "state" | "fingerprint" | "observedAt">,
): NonNullable<ForgeOperationResult["ownerAction"]> {
  const fingerprint = sha256([
    input.provider,
    input.detail,
    input.nextAction,
    input.expectedAccount,
    input.target,
  ].join("|"));
  const id = `forge-owner-action:${input.provider}:${fingerprint}`;
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

function clearOwnerActions(
  state: ForgeOperationState,
  capability: ForgeCapabilityProof,
): void {
  const target = capability.provider === "azure"
    ? `subscription:${capability.target}`
    : capability.target;
  for (const current of state.readForgeOwnerActionNotices()) {
    if (
      current.state === "cleared" ||
      current.provider !== capability.provider ||
      current.expectedAccount.toLowerCase() !== capability.account.toLowerCase() ||
      current.target.toLowerCase() !== target.toLowerCase()
    ) continue;
    state.appendForgeOwnerActionNotice({
      ...current,
      state: "cleared",
      detail: `${capability.provider} capability was proven available for the intended account and target.`,
      observedAt: capability.observedAt,
    });
  }
}

function classifyPreflightError(
  provider: ForgeProvider,
  error: unknown,
): {
  status: "rejected" | "unavailable" | "timed-out";
  detail: string;
  nextAction: string;
  ownerActionRequired: boolean;
} {
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
        : kind === "timeout"
          ? `Retry the inspection with a fresh bounded attempt; no provider effect was dispatched.`
        : `Correct the intended ${provider} account, target, or capability outside CMD Riker, then retry.`;
  return {
    status: kind === "timeout"
      ? "timed-out"
      : kind === "unavailable" || kind === "authentication" || kind === "interactive"
        ? "unavailable"
        : "rejected",
    detail,
    nextAction,
    ownerActionRequired: kind !== "timeout",
  };
}

function assertRequest(request: ForgeOperationRequest): void {
  if (!request.commitmentId.trim() || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new Error("Forge operations require a Commitment identity and positive timeout.");
  }
  if (!request.operation.expectedAccount.trim()) {
    throw new Error("Forge operations require the intended account identity.");
  }
  if (request.operation.kind !== "azure-subscription-inspection") {
    if (
      !/^[^/\s]+\/[^/\s]+$/.test(request.operation.repository) ||
      !Number.isInteger(request.operation.issueNumber) ||
      request.operation.issueNumber < 1
    ) {
      throw new Error("GitHub mutations require a repository and issue number.");
    }
  }
  if (request.operation.kind === "github-issue-comment") {
    if (
      !request.operation.body.trim() ||
      Buffer.byteLength(request.operation.body, "utf8") > 64 * 1024
    ) {
      throw new Error("GitHub issue comments require a bounded non-empty body.");
    }
    return;
  }
  if (request.operation.kind === "github-issue-close") {
    if (request.operation.stateReason !== "completed" && request.operation.stateReason !== "not-planned") {
      throw new Error("GitHub issue close requires the state reason completed or not-planned.");
    }
    return;
  }
  if (request.operation.kind === "github-issue-label-remove") {
    if (
      !request.operation.label.trim() ||
      request.operation.label !== request.operation.label.trim() ||
      Buffer.byteLength(request.operation.label, "utf8") > 100
    ) {
      throw new Error("GitHub label removal requires one bounded trimmed label name.");
    }
    return;
  }
  if (!/^[0-9a-f-]{36}$/i.test(request.operation.subscriptionId)) {
    throw new Error("Azure inspection requires one subscription UUID.");
  }
}

function assertConfiguredAuthority(
  configuration: OwnerConfiguration | undefined,
  request: ForgeOperationRequest,
): void {
  if (!configuration) throw new Error("Forge operations require the persisted Owner configuration.");
  if (request.operation.kind !== "azure-subscription-inspection") {
    const authority = configuration.forgeAuthorities?.github;
    if (!authority) throw new Error("GitHub Forge authority is not configured by the Owner.");
    if (
      authority.account.toLowerCase() !== request.operation.expectedAccount.toLowerCase() ||
      authority.repository.toLowerCase() !== request.operation.repository.toLowerCase()
    ) {
      throw new Error("GitHub operation is outside the configured Owner authority.");
    }
    return;
  }
  const authority = configuration.forgeAuthorities?.azure;
  if (!authority) throw new Error("Azure Forge authority is not configured by the Owner.");
  if (
    authority.account.toLowerCase() !== request.operation.expectedAccount.toLowerCase() ||
    authority.subscriptionId.toLowerCase() !== request.operation.subscriptionId.toLowerCase()
  ) {
    throw new Error("Azure operation is outside the configured Owner authority.");
  }
}

function targetLabel(target: ForgeOperationTarget): string {
  return target.kind === "azure-subscription"
    ? `subscription:${target.subscriptionId}`
    : `${target.repository}#${target.issueNumber}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining < 1) {
    throw new ForgeAdapterError("timeout", "The Forge operation exceeded its deadline before dispatch.");
  }
  return remaining;
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
        ...nativeCliEnvironment(),
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
      reject(new ForgeAdapterError("timeout", `${provider === "github" ? "GitHub" : "Azure"} CLI exceeded its operation deadline.`));
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

export function nativeCliEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ] as const;
  return Object.fromEntries(
    names.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]]]),
  );
}

function boundedAppend(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= 1024 * 1024 ? next : next.slice(0, 1024 * 1024);
}
