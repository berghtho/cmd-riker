import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState, type AuthoritativeState } from "../src/authoritative-state/index.ts";
import {
  createForgeOperations,
  ForgeAdapterError,
  nativeCliEnvironment,
  NativeAzureCli,
  type AzureCli,
  type ForgeCapabilityProof,
  type GitHubCli,
} from "../src/forge-operations/index.ts";
import { createOrchestrationCore, type Commitment } from "../src/orchestration-core/index.ts";

test("GitHub mutation records intent before dispatch and settles only after exact read-back", async (t) => {
  const { state, commitment, githubAuthorization } = await configuredState(t, "github-success");
  const body = "CMD Riker live-proof marker.";
  let createObservedDispatch = false;
  let inspectTimeout = 0;
  let createTimeout = 0;
  let readTimeout = 0;
  const github: GitHubCli = {
    inspect: async (input) => {
      inspectTimeout = input.timeoutMs;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return githubCapability();
    },
    createIssueComment: async (input) => {
      createTimeout = input.timeoutMs;
      const attempt = state.readForgeOperationAttempts()[0];
      assert.equal(attempt?.status, "running");
      assert.equal(attempt?.capability?.target, "berghtho/cmd-riker#36");
      assert.equal(state.readEffectIntent(attempt?.effectIntentId ?? "")?.status, "dispatching");
      createObservedDispatch = true;
      return { id: "comment-42", url: "https://github.test/comment-42" };
    },
    readIssueComment: async (input) => {
      readTimeout = input.timeoutMs;
      return {
        id: "comment-42",
        url: "https://github.test/comment-42",
        body,
        author: "berghtho",
        observedAt: "2026-08-19T20:00:00.000Z",
      };
    },
  };

  const result = await createForgeOperations(state, { github }).execute({
    commitmentId: commitment.id,
    operation: {
      kind: "github-issue-comment",
      repository: "berghtho/cmd-riker",
      issueNumber: 36,
      body,
      expectedAccount: "berghtho",
    },
    timeoutMs: 1_000,
    actingAuthorityEffectAuthorization: githubAuthorization!,
  });

  assert.equal(createObservedDispatch, true);
  assert.ok(createTimeout < inspectTimeout);
  assert.ok(readTimeout <= createTimeout);
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence[0]?.source, "provider-readback");
  assert.equal(state.readForgeOperationAttempt(result.operationAttemptId)?.status, "succeeded");
  assert.equal(state.readEffectIntent(result.effectIntentId ?? "")?.status, "succeeded");
  assert.doesNotMatch(JSON.stringify(state.readForgeOperationAttempts()), /CMD Riker live-proof marker/);
  createOrchestrationCore(state).observeForgeOperationResult(commitment.id, result);
  assert.equal(state.readCommitment(commitment.id)?.state, "accepted");
});

test("Forge authority is checked against durable Owner configuration before provider use", async (t) => {
  const { state, commitment, githubAuthorization } = await configuredState(t, "authority");
  let inspected = false;
  const github: GitHubCli = {
    inspect: async () => {
      inspected = true;
      return githubCapability();
    },
    createIssueComment: async () => assert.fail("mutation must not dispatch"),
    readIssueComment: async () => assert.fail("read-back must not run"),
  };

  await assert.rejects(
    createForgeOperations(state, { github }).execute({
      commitmentId: commitment.id,
      operation: {
        kind: "github-issue-comment",
        repository: "attacker/other",
        issueNumber: 36,
        body: "Not authorized.",
        expectedAccount: "attacker",
      },
      timeoutMs: 1_000,
      actingAuthorityEffectAuthorization: githubAuthorization!,
    }),
    /outside the configured Owner authority/,
  );
  assert.equal(inspected, false);
});

test("public GitHub mutation stops without an exact Standing Order grant", async (t) => {
  const { state, commitment, githubAuthorization } = await configuredState(t, "public-authority");
  let dispatched = false;
  const github: GitHubCli = {
    inspect: async () => githubCapability(),
    createIssueComment: async () => {
      dispatched = true;
      return { id: "comment-42", url: "https://github.test/comment-42" };
    },
    readIssueComment: async () => assert.fail("read-back must not run"),
  };
  await assert.rejects(
    createForgeOperations(state, { github }).execute({
      commitmentId: commitment.id,
      operation: {
        kind: "github-issue-comment",
        repository: "berghtho/cmd-riker",
        issueNumber: 36,
        body: "Not authorized by this grant.",
        expectedAccount: "berghtho",
      },
      timeoutMs: 1_000,
      actingAuthorityEffectAuthorization: {
        ...githubAuthorization!,
        authorizationId: "forged-authorization",
      },
    }),
    /does not match its durable Acting Authority authorization/,
  );
  assert.equal(dispatched, false);
});

test("deadline expiry before GitHub dispatch is a known no-effect timeout", async (t) => {
  const { state, commitment, githubAuthorization } = await configuredState(t, "pre-dispatch-timeout");
  let dispatched = false;
  const github: GitHubCli = {
    inspect: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return githubCapability();
    },
    createIssueComment: async () => {
      dispatched = true;
      return { id: "comment-42", url: "https://github.test/comment-42" };
    },
    readIssueComment: async () => assert.fail("read-back must not run"),
  };
  const result = await createForgeOperations(state, { github }).execute({
    commitmentId: commitment.id,
    operation: {
      kind: "github-issue-comment",
      repository: "berghtho/cmd-riker",
      issueNumber: 36,
      body: "Deadline proof.",
      expectedAccount: "berghtho",
    },
    timeoutMs: 5,
    actingAuthorityEffectAuthorization: githubAuthorization!,
  });

  assert.equal(result.status, "timed-out");
  assert.equal(result.uncertainty, null);
  assert.equal(dispatched, false);
  assert.equal(result.effectIntentId, undefined);
  assert.equal(state.readEffectIntents().length, 0);
});

test("provider preflight timeout does not masquerade as an Owner authentication action", async (t) => {
  const { state, commitment } = await configuredState(
    t,
    "azure-timeout",
    "azure-subscription-inspection",
  );
  const azure: AzureCli = {
    inspectSubscription: async () => {
      throw new ForgeAdapterError("timeout", "Azure CLI exceeded its operation deadline.");
    },
  };
  const result = await createForgeOperations(state, { azure }).execute({
    commitmentId: commitment.id,
    operation: {
      kind: "azure-subscription-inspection",
      subscriptionId: "00000000-0000-0000-0000-000000000036",
      expectedAccount: "owner@example.test",
    },
    timeoutMs: 1_000,
  });

  assert.equal(result.status, "timed-out");
  assert.equal(result.ownerAction, undefined);
  assert.equal(state.readForgeOwnerActionNotices().length, 0);
});

test("native CLI environment excludes ambient secret-bearing variables", () => {
  assert.deepEqual(nativeCliEnvironment({
    PATH: "C:\\tools",
    USERPROFILE: "C:\\Users\\owner",
    GH_TOKEN: "github-secret",
    AZURE_CLIENT_SECRET: "azure-secret",
    UNRELATED_SECRET: "other-secret",
  }), {
    PATH: "C:\\tools",
    USERPROFILE: "C:\\Users\\owner",
  });
});

test("missing GitHub authentication records one durable Owner action and deduplicates repeats", async (t) => {
  const { state, commitment, githubAuthorization } = await configuredState(t, "github-auth");
  const github: GitHubCli = {
    inspect: async () => {
      throw new ForgeAdapterError("authentication", "GitHub CLI authentication is unavailable.");
    },
    createIssueComment: async () => assert.fail("mutation must not dispatch"),
    readIssueComment: async () => assert.fail("read-back must not run"),
  };
  const operations = createForgeOperations(state, { github });
  const request = {
    commitmentId: commitment.id,
    operation: {
      kind: "github-issue-comment" as const,
      repository: "berghtho/cmd-riker",
      issueNumber: 36,
      body: "Not dispatched.",
      expectedAccount: "berghtho",
    },
    timeoutMs: 1_000,
    actingAuthorityEffectAuthorization: githubAuthorization!,
  };

  const first = await operations.execute(request);
  const second = await operations.execute(request);

  assert.equal(first.status, "unavailable");
  assert.equal(first.ownerAction?.disposition, "recorded");
  assert.equal(second.ownerAction?.disposition, "deduplicated");
  assert.equal(state.readForgeOwnerActionNotices().length, 1);
  assert.equal(state.readForgeOwnerActionNotices()[0]?.state, "active");
  assert.equal(state.readEffectIntents().length, 0);
});

test("an interactive Azure prompt becomes one non-interactive Owner action", async (t) => {
  const { state, commitment } = await configuredState(
    t,
    "azure-prompt",
    "azure-subscription-inspection",
  );
  const azure: AzureCli = {
    inspectSubscription: async () => {
      throw new ForgeAdapterError("interactive", "Azure CLI exceeded its non-interactive deadline.");
    },
  };
  const operations = createForgeOperations(state, { azure });
  const request = {
    commitmentId: commitment.id,
    operation: {
      kind: "azure-subscription-inspection" as const,
      subscriptionId: "00000000-0000-0000-0000-000000000036",
      expectedAccount: "owner@example.test",
    },
    timeoutMs: 1_000,
  };

  const first = await operations.execute(request);
  const second = await operations.execute(request);

  assert.equal(first.status, "unavailable");
  assert.equal(first.ownerAction?.disposition, "recorded");
  assert.equal(second.ownerAction?.disposition, "deduplicated");
  assert.match(first.ownerAction?.nextAction ?? "", /outside CMD Riker/);
  assert.equal(state.readForgeOwnerActionNotices().length, 1);
});

test("Azure inspection persists attributed read-only evidence and clears its Owner action", async (t) => {
  const { state, commitment } = await configuredState(
    t,
    "azure-success",
    "azure-subscription-inspection",
  );
  const unavailable = createForgeOperations(state, {
    azure: new NativeAzureCli("cmd-riker-definitely-missing-az"),
  });
  const request = {
    commitmentId: commitment.id,
    operation: {
      kind: "azure-subscription-inspection" as const,
      subscriptionId: "00000000-0000-0000-0000-000000000036",
      expectedAccount: "owner@example.test",
    },
    timeoutMs: 1_000,
  };
  assert.equal((await unavailable.execute(request)).status, "unavailable");

  const azure: AzureCli = {
    inspectSubscription: async () => ({
      capability: azureCapability(),
      evidence: {
        source: "provider-readback",
        reference: "azure-subscription:00000000-0000-0000-0000-000000000036",
        summary: "Azure subscription Test is enabled for the intended account.",
        observedAt: "2026-08-19T20:00:00.000Z",
      },
    }),
  };
  const result = await createForgeOperations(state, { azure }).execute(request);

  assert.equal(result.status, "succeeded");
  assert.equal(result.effectIntentId, undefined);
  assert.equal(result.capability?.account, "owner@example.test");
  assert.equal(state.readForgeOperationAttempt(result.operationAttemptId)?.status, "succeeded");
  assert.equal(state.readForgeOwnerActionNotices()[0]?.state, "cleared");
  createOrchestrationCore(state).observeForgeOperationResult(commitment.id, result);
  assert.equal(state.readCommitment(commitment.id)?.state, "accepted");
});

test("Owner actions remain scoped when the configured Azure target changes", async (t) => {
  const { state, commitment } = await configuredState(
    t,
    "azure-scopes",
    "azure-subscription-inspection",
  );
  const unavailableAzure: AzureCli = {
    inspectSubscription: async () => {
      throw new ForgeAdapterError("authentication", "Azure CLI authentication is unavailable.");
    },
  };
  const target36Request = {
    commitmentId: commitment.id,
    operation: {
      kind: "azure-subscription-inspection" as const,
      subscriptionId: "00000000-0000-0000-0000-000000000036",
      expectedAccount: "owner@example.test",
    },
    timeoutMs: 1_000,
  };
  await createForgeOperations(state, { azure: unavailableAzure }).execute(target36Request);
  const configuration = state.readOwnerConversation();
  assert.ok(configuration);
  const { messages: _messages, ...ownerConfiguration } = configuration;
  state.replaceOwnerConfiguration({
    ...ownerConfiguration,
    forgeAuthorities: {
      ...ownerConfiguration.forgeAuthorities,
      azure: {
        account: "owner@example.test",
        subscriptionId: "00000000-0000-0000-0000-000000000037",
      },
    },
  });
  const target37Request = {
    ...target36Request,
    operation: {
      ...target36Request.operation,
      subscriptionId: "00000000-0000-0000-0000-000000000037",
    },
  };
  await createForgeOperations(state, { azure: unavailableAzure }).execute(target37Request);
  assert.equal(state.readForgeOwnerActionNotices().filter((notice) => notice.state === "active").length, 2);

  const availableAzure: AzureCli = {
    inspectSubscription: async () => ({
      capability: {
        ...azureCapability(),
        target: "00000000-0000-0000-0000-000000000037",
      },
      evidence: {
        source: "provider-readback",
        reference: "azure-subscription:00000000-0000-0000-0000-000000000037",
        summary: "Azure subscription 37 is enabled for the intended account.",
        observedAt: "2026-08-19T20:00:00.000Z",
      },
    }),
  };
  await createForgeOperations(state, { azure: availableAzure }).execute(target37Request);
  const notices = state.readForgeOwnerActionNotices();
  assert.equal(notices.find((notice) => notice.target.endsWith("36"))?.state, "active");
  assert.equal(notices.find((notice) => notice.target.endsWith("37"))?.state, "cleared");
});

test("mismatched GitHub read-back leaves the dispatched effect unknown", async (t) => {
  const { state, commitment, githubAuthorization } = await configuredState(t, "github-unknown");
  const github: GitHubCli = {
    inspect: async () => githubCapability(),
    createIssueComment: async () => ({ id: "comment-42", url: "https://github.test/comment-42" }),
    readIssueComment: async () => ({
      id: "comment-42",
      url: "https://github.test/comment-42",
      body: "Different content.",
      author: "berghtho",
      observedAt: "2026-08-19T20:00:00.000Z",
    }),
  };

  const result = await createForgeOperations(state, { github }).execute({
    commitmentId: commitment.id,
    operation: {
      kind: "github-issue-comment",
      repository: "berghtho/cmd-riker",
      issueNumber: 36,
      body: "Intended content.",
      expectedAccount: "berghtho",
    },
    timeoutMs: 1_000,
    actingAuthorityEffectAuthorization: githubAuthorization!,
  });

  assert.equal(result.status, "unknown");
  assert.equal(state.readEffectIntent(result.effectIntentId ?? "")?.status, "unknown");
  assert.match(result.uncertainty?.nextAction ?? "", /before any retry/);
  createOrchestrationCore(state).observeForgeOperationResult(commitment.id, result);
  assert.equal(state.readCommitment(commitment.id)?.condition?.kind, "reconciling");
});

test("restart marks a dispatched GitHub mutation unknown without replay", async (t) => {
  const { state, commitment, githubAuthorization } = await configuredState(t, "github-restart");
  const startedAt = "2026-08-19T20:00:00.000Z";
  const attempt = {
    id: "forge-attempt-restart",
    commitmentId: commitment.id,
    effectIntentId: "forge-effect-restart",
    provider: "github" as const,
    operation: "github-issue-comment" as const,
    target: {
      kind: "github-issue" as const,
      repository: "berghtho/cmd-riker",
      issueNumber: 36,
      bodySha256: "0".repeat(64),
    },
    expectedAccount: "berghtho",
    timeoutMs: 30_000,
    status: "ready" as const,
    startedAt,
  };
  const effect = {
    id: "forge-effect-restart",
    commitmentId: commitment.id,
    kind: "forge-operation" as const,
    forgeOperationAttemptId: attempt.id,
    provider: "github" as const,
    effectScopeKey: "github:berghtho/cmd-riker:issue:36",
    expectedEffect: "Create one attributed GitHub issue comment.",
    authorization: {
      kind: "lead-agent-command-authority" as const,
      commitmentId: commitment.id,
      providerTarget: { provider: "github" as const, resource: "berghtho/cmd-riker#36" },
      validatedAt: startedAt,
      actingAuthority: githubAuthorization!,
    },
    retryRule: "Read back before retry.",
    status: "pending" as const,
  };
  state.startForgeMutation(attempt, effect);
  state.claimForgeMutation(
    { ...attempt, status: "running" },
    {
      ...effect,
      status: "dispatching",
      lease: {
        claimedAt: startedAt,
        expiresAt: "2026-08-19T20:00:30.000Z",
      },
    },
  );

  createOrchestrationCore(state).reconcileInterruptedCommitments();

  assert.equal(state.readForgeOperationAttempt(attempt.id)?.status, "unknown");
  assert.equal(state.readEffectIntent(effect.id)?.status, "unknown");
  assert.equal(state.readCommitment(commitment.id)?.condition?.kind, "reconciling");
});

async function configuredState(
  t: test.TestContext,
  suffix: string,
  operation: "github-issue-comment" | "azure-subscription-inspection" = "github-issue-comment",
): Promise<{
  state: AuthoritativeState;
  commitment: Commitment;
  githubAuthorization?: {
    actingAuthorityId: string;
    authorizationId: string;
    standingOrderId: string;
  };
}> {
  const stateDirectory = await mkdtemp(join(tmpdir(), `cmd-riker-forge-${suffix}-`));
  const state = openAuthoritativeState(stateDirectory);
  t.after(async () => {
    state.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    forgeAuthorities: {
      github: { account: "berghtho", repository: "berghtho/cmd-riker" },
      azure: {
        account: "owner@example.test",
        subscriptionId: "00000000-0000-0000-0000-000000000036",
      },
    },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  const orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Perform one typed Forge operation.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "One typed Forge operation is completed.",
    criteria: [{
      kind: "forge-operation",
      description: "The typed Forge operation succeeds with attributed evidence.",
      operation,
    }],
  });
  if (operation === "azure-subscription-inspection") return { state, commitment };
  const validUntil = new Date(Date.now() + 60_000).toISOString();
  const standingOrderInstruction =
    `Begin Acting Authority. Standing Order: update on berghtho/cmd-riker#36; ` +
    `externally binding reversible effects; cost 0 USD until ${validUntil}.`;
  const standingOrderTurnId = state.appendOwnerMessage(standingOrderInstruction);
  const standingOrder = orchestration.recordStandingOrder(standingOrderTurnId, {
    title: "Issue 36 public comments",
    instruction: standingOrderInstruction,
    commitmentIds: [commitment.id],
    effectClasses: ["update"],
    targets: ["berghtho/cmd-riker#36"],
    allowIrreversibleEffects: false,
    allowExternallyBindingEffects: true,
    maximumIncrementalSpendUsd: 0,
    validUntil,
    ownerInstructionQuote: standingOrderInstruction,
  });
  const acting = orchestration.beginActingAuthority(standingOrderTurnId, {
    commitmentIds: [commitment.id],
    standingOrderIds: [standingOrder.id],
    ownerInstructionQuote: standingOrderInstruction,
  });
  const authorization = orchestration.authorizeActingAuthorityEffect({
    actingAuthorityId: acting.id,
    commitmentId: commitment.id,
    effectClass: "update",
    target: "berghtho/cmd-riker#36",
    reversible: true,
    externallyBinding: true,
    incrementalSpendUsd: 0,
  });
  return {
    state,
    commitment,
    githubAuthorization: {
      actingAuthorityId: authorization.actingAuthorityId,
      authorizationId: authorization.id,
      standingOrderId: authorization.standingOrderId,
    },
  };
}

function githubCapability(): ForgeCapabilityProof {
  return {
    provider: "github",
    executable: "gh",
    version: "gh version 2.97.0",
    authentication: "verified",
    account: "berghtho",
    target: "berghtho/cmd-riker#36",
    capability: "issue-comment:ADMIN",
    observedAt: "2026-08-19T20:00:00.000Z",
  };
}

function azureCapability(): ForgeCapabilityProof {
  return {
    provider: "azure",
    executable: "az",
    version: "2.77.0",
    authentication: "verified",
    account: "owner@example.test",
    target: "00000000-0000-0000-0000-000000000036",
    capability: "subscription-inspection",
    observedAt: "2026-08-19T20:00:00.000Z",
  };
}
