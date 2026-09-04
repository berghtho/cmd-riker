import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import {
  DeterministicTurnAdapter,
  PiAgentTurnAdapter,
  type PiTurnRequest,
} from "../src/conversation-runtime/index.ts";
import { createLeadAgentRuntime } from "../src/lead-agent-runtime/index.ts";
import {
  createOrchestrationCore,
  type StandingOrder,
  type WorkerSession,
} from "../src/orchestration-core/index.ts";
import type { WorkerSupervisor } from "../src/worker-supervisor/index.ts";
import { startLocalModel } from "./support/local-model.ts";
import type { ForgeOperationAttempt } from "../src/forge-operations/index.ts";
import type { ForgeOperationEffectIntent } from "../src/target-project-operations/index.ts";

async function setup(t: TestContext, baseUrl = "http://127.0.0.1:1/v1") {
  const directory = await mkdtemp(join(tmpdir(), "cmd-riker-project-scope-"));
  const state = openAuthoritativeState(directory);
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const paths = { a: join(directory, "project-a"), b: join(directory, "project-b") };
  state.initialize({
    targetProject: { path: paths.a },
    projects: [{ name: "B", path: paths.b }],
    modelSelection: {
      provider: "local-openai", model: "owner-model", api: "openai-completions", baseUrl,
    },
    modelPolicyRevision: "test",
    workerModelPolicy: {
      revision: "test",
      selection: { provider: "openai", nativeHarness: "codex", model: "gpt-5.6-sol" },
    },
    forgeAuthorities: {
      github: { account: "owner", repository: "owner/project" },
      azure: { account: "owner", subscriptionId: "00000000-0000-0000-0000-000000000001" },
    },
  });
  for (const session of [
    {
      id: "b", name: "B", projectPath: paths.b,
      state: "active", createdAt: new Date().toISOString(),
    },
    {
      id: "another-a", name: "Another A", projectPath: paths.a,
      state: "active", createdAt: new Date().toISOString(),
    },
  ] as const) state.appendOwnerSessionSnapshots([session]);
  const orchestration = createOrchestrationCore(state);
  const records = (["a", "b"] as const).map((project) => {
    const turnId = state.appendOwnerMessage(`Work in ${project}.`, project === "a" ? undefined : "b");
    const commitment = orchestration.recordCommitment(turnId, {
      outcome: `${project} outcome`,
      criteria: [{ kind: "target-project-operation", description: "tests pass", operation: "test" }],
    });
    const worker: WorkerSession = {
      id: `worker-${project}`, state: "waiting-question", currentExecutionAttemptId: `attempt-${project}`,
      assignment: {
        readOnly: true, targetProjectPath: paths[project], commitmentId: commitment.id,
        objective: `${project} research`, prompt: "Investigate.", modelPolicyRevision: "test",
      },
    };
    state.appendWorkerSessionSnapshots([worker]);
    state.appendWorkerExecutionAttemptSnapshots([{
      id: worker.currentExecutionAttemptId, workerSessionId: worker.id, generation: 1,
      modelSelection: { provider: "openai", nativeHarness: "codex", model: "gpt-5.6-sol" },
      modelPolicyRevision: "test", status: "running",
    }]);
    state.appendWorkerQuestionSnapshots([{
      id: `question-${project}`, workerSessionId: worker.id,
      executionAttemptId: worker.currentExecutionAttemptId, providerRequestId: 1,
      itemId: "item", status: "open",
      questions: [{ id: "choice", question: `${project} decision?`, isOther: true }],
    }]);
    const order: StandingOrder = {
      id: `order-${project}`, title: `${project} constraints`,
      instruction: `Only merge ${project} after tests pass.`,
      ownerInstructionQuote: `Only merge ${project} after tests pass.`,
      commitmentIds: [commitment.id], effectClasses: ["merge"], targets: ["main"],
      allowIrreversibleEffects: false, allowExternallyBindingEffects: false,
      maximumIncrementalSpendUsd: 4.25, validFrom: new Date().toISOString(),
      validUntil: new Date(Date.now() + 3600_000).toISOString(),
      createdByOwnerTurnId: turnId, state: "active",
    };
    state.appendStandingOrderSnapshots([order]);
    return { commitment, worker, order };
  });
  return { state, paths, a: records[0]!, b: records[1]! };
}

class InspectingAdapter extends DeterministicTurnAdapter {
  private inspect: (request: PiTurnRequest) => Promise<void> | void;
  constructor(inspect: (request: PiTurnRequest) => Promise<void> | void) {
    super();
    this.inspect = inspect;
  }
  override async completeTurn(request: PiTurnRequest) {
    await this.inspect(request);
    return { content: "Ready." };
  }
}

test("Lead context and account delivery stay in the project across Owner Sessions", async (t) => {
  const { state, paths, a, b } = await setup(t);
  for (const { commitment } of [a, b]) {
    state.appendCommitmentSnapshots([{
      ...commitment, outcomeAccount: { content: `${commitment.outcome} delivered` },
    }]);
  }
  for (const record of [a, b]) {
    const budget = {
      maximumAttempts: 1, deadline: new Date(Date.now() + 3600_000).toISOString(),
      maximumIncrementalSpendUsd: 0, allowedEffects: ["lead-candidate-activation" as const],
    };
    state.appendSelfRepairSnapshots([{
      version: 2, id: `repair-${record.worker.id}`, commitmentId: record.commitment.id,
      defect: {
        subject: "runtime", description: "repair",
        evidence: ["failure"], diagnosedAt: new Date().toISOString(),
      },
      authority: {
        kind: "lead-agent-command-authority",
        authorizedAt: new Date().toISOString(), authorizedWriteRoot: paths.a,
      },
      envelope: budget,
      attempts: [{
        id: `repair-attempt-${record.worker.id}`, hypothesis: "fix", changedEvidence: [],
        status: "activated", budget: { ...budget, attemptNumber: 1 },
        activation: {
          outcome: "activated", evidence: ["passed"], observedAt: new Date().toISOString(),
          account: `${record.commitment.outcome} repair`,
        },
      }],
    }]);
  }
  const runtimeFor = (expected: typeof a, cwd: string) => createLeadAgentRuntime({
    state, adapter: new InspectingAdapter((request) => {
      assert.deepEqual(request.commitments?.map((item) => item.id), [expected.commitment.id]);
      assert.deepEqual(request.workers?.map((item) => item.id), [expected.worker.id]);
      assert.deepEqual(request.workerQuestions?.map((item) => item.workerSessionId), [expected.worker.id]);
      assert.deepEqual(request.standingOrders?.map((item) => item.id), [expected.order.id]);
      assert.equal(request.nativeTools?.cwd, cwd);
    }),
  });
  const responseB = await runtimeFor(b, paths.b).completeOwnerTurn("Status?", undefined, "b");
  assert.match(responseB, /b outcome delivered/);
  assert.match(responseB, /b outcome repair/);
  assert.doesNotMatch(responseB, /a outcome/);
  assert.equal(state.readCommitment(a.commitment.id)?.outcomeAccount?.deliveredAt, undefined);
  assert.equal(state.readSelfRepair(`repair-${a.worker.id}`)?.attempts[0]?.activation?.deliveredAt, undefined);
  assert.ok(state.readCommitment(b.commitment.id)?.outcomeAccount?.deliveredAt);
  const responseA = await runtimeFor(a, paths.a).completeOwnerTurn("Status?", undefined, "another-a");
  assert.match(responseA, /a outcome delivered/);
  assert.match(responseA, /a outcome repair/);
  assert.doesNotMatch(responseA, /b outcome/);
  assert.ok(state.readCommitment(a.commitment.id)?.outcomeAccount?.deliveredAt);
  const primaryResponse = await runtimeFor(a, paths.a).completeOwnerTurn("Anything else?");
  assert.equal(primaryResponse, "Ready.");
});

test("all Lead actions reject foreign project identifiers before mutation or external calls", async (t) => {
  const { state, a, b } = await setup(t);
  let externalCalls = 0;
  const unexpected = async (): Promise<never> => {
    externalCalls++;
    throw new Error("Unexpected external call.");
  };
  const workerSupervisor: WorkerSupervisor = {
    capabilities: () => ({
      nativeHarness: "codex", effectful: true, nativeQuestions: true, cancellation: true,
    }),
    delegate: unexpected, delegateEffectful: unexpected, delegateReview: unexpected,
    answer: unexpected, steer: unexpected, cancel: unexpected, recover: unexpected,
    workerOutput: () => { externalCalls++; return "foreign output"; },
  };
  await createLeadAgentRuntime({
    state, workerSupervisor, targetProjectOperations: { execute: unexpected },
    forgeOperations: { execute: unexpected, readBackEffect: unexpected },
    adapter: new InspectingAdapter(async (request) => {
      const work = request.commitmentActions!;
      const workers = request.workerActions!;
      const harness = workers.harnesses[0]!;
      const forge = request.forgeActions!;
      const assignment = { objective: "Work", prompt: "Do it", commitmentId: a.commitment.id };
      const actions = [
        () => work.resume(a.commitment.id),
        () => work.cancel!(a.commitment.id, "Cancel."),
        () => work.recordOwnerVerdict!(a.commitment.id, "Verified."),
        () => work.executeOperation(a.commitment.id, "test"),
        () => request.authorityActions!.recordStandingOrder({ ...a.order, instruction: "Approved.", ownerInstructionQuote: "Approved." }),
        () => request.authorityActions!.revokeStandingOrder(a.order.id, "Revoke."),
        () => harness.delegate(assignment),
        () => harness.delegate({ ...assignment, commitmentId: b.commitment.id, recoveryOfWorkerSessionId: a.worker.id }),
        () => harness.delegateEffectful!({ ...assignment, targets: ["src"] }),
        () => harness.delegateEffectful!({ ...assignment, commitmentId: b.commitment.id, targets: ["src"], recoveryOfWorkerSessionId: a.worker.id }),
        () => workers.delegateReview!({ implementationWorkerSessionId: a.worker.id, prompt: "Review." }),
        () => workers.adjudicateReview!({ commitmentId: a.commitment.id, decisions: [] }),
        () => workers.reserveOwnerDecision!("question-a", "Decide."),
        () => workers.steer!(a.worker.id, "Go."),
        () => workers.workerOutput!(a.worker.id),
        () => workers.answer!("question-a", { choice: ["yes"] }),
        () => workers.cancel!(a.worker.id, "Stop."),
        () => forge.commentOnGitHubIssue!({ commitmentId: a.commitment.id, issueNumber: 1, body: "Done." }),
        () => forge.closeGitHubIssue!({ commitmentId: a.commitment.id, issueNumber: 1 }),
        () => forge.removeGitHubIssueLabel!({ commitmentId: a.commitment.id, issueNumber: 1, label: "pending" }),
        () => forge.inspectAzureSubscription!(a.commitment.id),
      ];
      for (const action of actions) await assert.rejects(async () => action(), /outside the active Target Project/);
      work.cancel!(b.commitment.id, "Owner requested cancellation.");
    }),
  }).completeOwnerTurn("Approved. Cancel the local work.", undefined, "b");
  assert.equal(externalCalls, 0);
  assert.equal(state.readCommitment(a.commitment.id)?.state, a.commitment.state);
  assert.equal(state.readCommitment(b.commitment.id)?.state, "cancelled");
  assert.equal(state.readStandingOrder(a.order.id)?.state, "active");
  assert.equal(state.readWorkerQuestion("question-a")?.ownerAttention, undefined);
});

test("uncertain Forge effects reconcile only in the owning project", async (t) => {
  const { state, a } = await setup(t);
  const startedAt = new Date().toISOString();
  const attempt: ForgeOperationAttempt = {
    id: "forge-a", commitmentId: a.commitment.id, effectIntentId: "effect-a", provider: "github", operation: "github-issue-close", target: { kind: "github-issue-state", repository: "owner/project", issueNumber: 1, state: "closed", stateReason: "completed" }, expectedAccount: "owner", timeoutMs: 30_000, status: "ready", startedAt,
  };
  const effect: ForgeOperationEffectIntent = {
    id: "effect-a", commitmentId: a.commitment.id, kind: "forge-operation", forgeOperationAttemptId: "forge-a", provider: "github", effectScopeKey: "github:owner/project:issue:1", expectedEffect: "Issue closed", authorization: { kind: "lead-agent-command-authority", commitmentId: a.commitment.id, validatedAt: startedAt }, retryRule: "read back", status: "pending",
  };
  state.startForgeMutation(attempt, effect);
  state.claimForgeMutation({ ...attempt, status: "running" }, { ...effect, status: "dispatching", lease: { claimedAt: startedAt, expiresAt: new Date(Date.now() + 30_000).toISOString() } });
  state.settleForgeMutation({ ...attempt, status: "unknown" }, { ...effect, status: "unknown" });
  let readBacks = 0;
  const runtime = createLeadAgentRuntime({
    state, adapter: new DeterministicTurnAdapter("Ready."), forgeOperations: {
      async execute() { throw new Error("Unexpected dispatch."); },
      async readBackEffect() { readBacks++; throw new Error("Provider unavailable."); },
    },
  });
  await runtime.completeOwnerTurn("Status?", undefined, "b");
  assert.equal(readBacks, 0);
  await runtime.completeOwnerTurn("Status?", undefined, "another-a");
  assert.equal(readBacks, 1);
});

test("the production model receives the exact Standing Order instruction and constraints", async (t) => {
  const instruction = 'Merge only after "required" checks pass.\nSpend at most $4.25.';
  let systemPrompt = "";
  const model = await startLocalModel((_call, request) => {
    const body = request as { messages: Array<{ role: string; content: string }> };
    systemPrompt = body.messages.find((message) => message.role === "system")!.content;
    return "Understood.";
  });
  t.after(() => model.close());
  const { state, a } = await setup(t, model.baseUrl);
  state.appendStandingOrderSnapshots([{ ...a.order, instruction, ownerInstructionQuote: instruction }]);
  await createLeadAgentRuntime({ state, adapter: new PiAgentTurnAdapter() }).completeOwnerTurn("What constraints apply?");
  assert.ok(systemPrompt.includes(`instruction ${JSON.stringify(instruction)}`));
  assert.ok(systemPrompt.includes(`Owner quote ${JSON.stringify(instruction)}`));
  assert.ok(systemPrompt.includes(`valid from ${a.order.validFrom} until ${a.order.validUntil}`));
  assert.match(systemPrompt, /maximum incremental spend USD 4\.25/);
  assert.match(systemPrompt, /irreversible false; externally binding false/);
  assert.doesNotMatch(systemPrompt, /b constraints/);
});
