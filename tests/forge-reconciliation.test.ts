import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openAuthoritativeState,
  type AuthoritativeState,
  type Commitment,
} from "../src/authoritative-state/index.ts";
import { DeterministicTurnAdapter } from "../src/conversation-runtime/index.ts";
import {
  createForgeOperations,
  type ForgeCapabilityProof,
  type GitHubCli,
} from "../src/forge-operations/index.ts";
import { createLeadAgentRuntime } from "../src/lead-agent-runtime/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";

test("an uncertain label removal settles as applied through provider read-back", async (t) => {
  const { state, commitment } = await configuredState(t, "readback-applied");
  const github = githubCli({
    removeIssueLabel: async () => {
      throw new Error("Connection lost after dispatch.");
    },
    readIssueLabels: async () => ({
      labels: ["enhancement"],
      url: "https://github.test/issues/36",
      observedAt: "2026-08-19T20:05:00.000Z",
    }),
  });
  const forgeOperations = createForgeOperations(state, { github });
  const orchestration = createOrchestrationCore(state);

  const result = await forgeOperations.execute(labelRemoveRequest(commitment.id));
  assert.equal(result.status, "unknown");
  orchestration.observeForgeOperationResult(commitment.id, result);
  assert.equal(state.readCommitment(commitment.id)?.condition?.kind, "reconciling");

  const readBack = await forgeOperations.readBackEffect({
    target: state.readForgeOperationAttempt(result.operationAttemptId)!.target,
    expectedAccount: "berghtho",
    timeoutMs: 1_000,
  });
  assert.equal(readBack.applied, true);
  orchestration.reconcileForgeEffect({
    effectIntentId: result.effectIntentId!,
    applied: readBack.applied,
    evidence: readBack.evidence,
  });

  const effect = state.readEffectIntent(result.effectIntentId!);
  assert.equal(effect?.status, "reconciled");
  assert.equal(effect?.reconciliation?.disposition, "confirmed-applied");
  const settled = state.readCommitment(commitment.id);
  assert.equal(settled?.state, "accepted");
  assert.equal(settled?.verification?.passed, true);
  assert.match(settled?.outcomeAccount?.content ?? "", /Delivered: /);
});

test("an uncertain label removal that provably never landed frees the Commitment for retry", async (t) => {
  const { state, commitment } = await configuredState(t, "readback-retry");
  let removals = 0;
  const github = githubCli({
    removeIssueLabel: async () => {
      removals += 1;
      if (removals === 1) throw new Error("Connection lost after dispatch.");
    },
    readIssueLabels: async () => ({
      labels: removals > 1 ? ["enhancement"] : ["enhancement", "status: verify"],
      url: "https://github.test/issues/36",
      observedAt: "2026-08-19T20:05:00.000Z",
    }),
  });
  const forgeOperations = createForgeOperations(state, { github });
  const orchestration = createOrchestrationCore(state);

  const uncertain = await forgeOperations.execute(labelRemoveRequest(commitment.id));
  assert.equal(uncertain.status, "unknown");
  orchestration.observeForgeOperationResult(commitment.id, uncertain);

  const readBack = await forgeOperations.readBackEffect({
    target: state.readForgeOperationAttempt(uncertain.operationAttemptId)!.target,
    expectedAccount: "berghtho",
    timeoutMs: 1_000,
  });
  assert.equal(readBack.applied, false);
  orchestration.reconcileForgeEffect({
    effectIntentId: uncertain.effectIntentId!,
    applied: readBack.applied,
    evidence: readBack.evidence,
  });
  assert.equal(
    state.readEffectIntent(uncertain.effectIntentId!)?.reconciliation?.disposition,
    "confirmed-not-applied",
  );
  const freed = state.readCommitment(commitment.id);
  assert.equal(freed?.state, "active");
  assert.equal(freed?.condition, undefined);

  const retried = await forgeOperations.execute(labelRemoveRequest(commitment.id));
  assert.equal(retried.status, "succeeded");
  orchestration.observeForgeOperationResult(commitment.id, retried);
  assert.equal(state.readCommitment(commitment.id)?.state, "accepted");
});

test("a comment effect has no deterministic read-back and stays for attributed reconciliation", async (t) => {
  const { state } = await configuredState(t, "readback-comment");
  const forgeOperations = createForgeOperations(state, { github: githubCli({}) });
  await assert.rejects(
    forgeOperations.readBackEffect({
      target: {
        kind: "github-issue",
        repository: "berghtho/cmd-riker",
        issueNumber: 36,
        bodySha256: "0".repeat(64),
      },
      expectedAccount: "berghtho",
      timeoutMs: 1_000,
    }),
    /no deterministically re-observable target/,
  );
});

test("the Lead runtime settles uncertain Forge effects at turn start and delivers the account", async (t) => {
  const { state, commitment } = await configuredState(t, "readback-turn");
  let healthy = false;
  const github = githubCli({
    removeIssueLabel: async () => {
      throw new Error("Connection lost after dispatch.");
    },
    readIssueLabels: async () => {
      if (!healthy) throw new Error("Read-back unavailable.");
      return {
        labels: ["enhancement"],
        url: "https://github.test/issues/36",
        observedAt: "2026-08-19T20:05:00.000Z",
      };
    },
  });
  const forgeOperations = createForgeOperations(state, { github });
  const orchestration = createOrchestrationCore(state);
  const uncertain = await forgeOperations.execute(labelRemoveRequest(commitment.id));
  assert.equal(uncertain.status, "unknown");
  orchestration.observeForgeOperationResult(commitment.id, uncertain);
  assert.equal(state.readCommitment(commitment.id)?.condition?.kind, "reconciling");

  healthy = true;
  const runtime = createLeadAgentRuntime({
    state,
    adapter: new DeterministicTurnAdapter("Standing by."),
    forgeOperations,
  });
  const response = await runtime.completeOwnerTurn("status?");

  const settled = state.readCommitment(commitment.id);
  assert.equal(settled?.state, "accepted");
  assert.match(response, /Delivered: One typed Forge operation is completed\./);
  // The settled account is the single Owner-facing line; no duplicate notice.
  assert.doesNotMatch(response, /Work item delivered: /);
});

function labelRemoveRequest(commitmentId: string) {
  return {
    commitmentId,
    operation: {
      kind: "github-issue-label-remove" as const,
      repository: "berghtho/cmd-riker",
      issueNumber: 36,
      label: "status: verify",
      expectedAccount: "berghtho",
    },
    timeoutMs: 1_000,
  };
}

async function configuredState(
  t: test.TestContext,
  suffix: string,
): Promise<{ state: AuthoritativeState; commitment: Commitment }> {
  const stateDirectory = await mkdtemp(join(tmpdir(), `cmd-riker-forge-reconcile-${suffix}-`));
  const state = openAuthoritativeState(stateDirectory);
  t.after(async () => {
    state.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    forgeAuthorities: {
      github: { account: "berghtho", repository: "berghtho/cmd-riker" },
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
  const turnId = state.appendOwnerMessage("Remove the stale label.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "One typed Forge operation is completed.",
    criteria: [{
      kind: "forge-operation",
      description: "The typed Forge operation succeeds with attributed evidence.",
      operation: "github-issue-label-remove",
    }],
  });
  return { state, commitment };
}

function githubCli(overrides: Partial<GitHubCli>): GitHubCli {
  return {
    inspect: async () => githubCapability(),
    createIssueComment: async () => assert.fail("createIssueComment must not run"),
    readIssueComment: async () => assert.fail("readIssueComment must not run"),
    closeIssue: async () => assert.fail("closeIssue must not run"),
    readIssueState: async () => assert.fail("readIssueState must not run"),
    removeIssueLabel: async () => assert.fail("removeIssueLabel must not run"),
    readIssueLabels: async () => assert.fail("readIssueLabels must not run"),
    ...overrides,
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
    capability: "issue-label-remove:ADMIN",
    observedAt: "2026-08-19T20:00:00.000Z",
  };
}
