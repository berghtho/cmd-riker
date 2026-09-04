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
import { pendingLeadContinuations } from "../src/lead-continuation/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";
import type { WorkerSupervisor } from "../src/worker-supervisor/index.ts";
import { startLocalModel } from "./support/local-model.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cmd-riker-autonomy-"));
  const state = openAuthoritativeState(directory);
  t.after(async () => {
    state.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = join(directory, "project");
  const otherProject = join(directory, "other-project");
  state.initialize({
    targetProject: { path: project },
    projects: [{ name: "Other", path: otherProject }],
    modelSelection: {
      provider: "local-openai", model: "owner-model",
      api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1",
    },
    modelPolicyRevision: "test",
    workerModelPolicy: {
      revision: "test",
      selection: { provider: "openai", nativeHarness: "codex", model: "gpt-5.6-sol" },
    },
  });
  state.appendOwnerSessionSnapshots([{
    id: "other", name: "Other", projectPath: otherProject,
    state: "active", createdAt: new Date().toISOString(),
  }]);
  const core = createOrchestrationCore(state);
  const answers: Array<{ questionId: string; ownerTurnId: string }> = [];
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected Worker action."); };
  const supervisor: WorkerSupervisor = {
    capabilities: () => ({
      nativeHarness: "codex", effectful: false, nativeQuestions: true, cancellation: true,
    }),
    async delegate(input) {
      const { model, ...assignment } = input;
      const created = core.delegateReadOnlyWorker({
        ...assignment,
        modelSelection: { provider: "openai", nativeHarness: "codex", model },
      });
      state.appendWorkerState({
        workerSession: { ...created.workerSession, state: "running" },
        executionAttempt: { ...created.executionAttempt, status: "running" },
      });
      return {
        workerSessionId: created.workerSession.id,
        executionAttemptId: created.executionAttempt.id,
      };
    },
    async answer(questionId, ownerTurnId, answer) {
      assert.equal(state.readLeadContinuations().at(-1)?.status, "started");
      answers.push({ questionId, ownerTurnId });
      core.recordWorkerAnswer(questionId, ownerTurnId, answer);
      core.observeWorkerAnswerDelivered(questionId);
    },
    delegateEffectful: unexpected, delegateReview: unexpected,
    steer: unexpected, cancel: unexpected, recover: unexpected,
    workerOutput: () => "Research in progress.",
  };
  let autonomousCalls = 0;
  let onContinuation = async (_request: PiTurnRequest): Promise<void> => {};
  class Adapter extends DeterministicTurnAdapter {
    override async completeTurn(request: PiTurnRequest) {
      if (request.continuation) {
        autonomousCalls++;
        const receipt = state.readLeadContinuations().at(-1);
        assert.equal(receipt?.status, "started", "Model callback requires a durable claim first.");
        assert.equal(receipt.workerSessionId, request.continuation.workerSessionId);
        await onContinuation(request);
        return { content: "The Worker has its answer." };
      }
      if (request.ownerInput === "Research the original project.") {
        await request.workerActions!.harnesses[0]!.delegate({
          objective: "Investigate the original project", prompt: "Read and report.",
        });
      }
      return { content: "I am working on it." };
    }
  }
  const runtime = createLeadAgentRuntime({ state, adapter: new Adapter(), workerSupervisor: supervisor });
  await runtime.completeOwnerTurn("Research the original project.");
  const origin = state.latestOwnerTurnId()!;
  const worker = state.readWorkerSessions()[0]!;
  const question = core.observeWorkerQuestion({
    workerSessionId: worker.id, executionAttemptId: worker.currentExecutionAttemptId,
    providerRequestId: 1, itemId: "scope",
    questions: [{ id: "scope", question: "Which module should I inspect?", isOther: true }],
  });
  const candidate = pendingLeadContinuations(state)[0]!;
  assert.ok(candidate);
  return {
    state, core, runtime, supervisor, project, otherProject, origin, worker, question, candidate, answers,
    get autonomousCalls() { return autonomousCalls; },
    onContinuation(callback: typeof onContinuation) { onContinuation = callback; },
  };
}

test("a Worker question resumes its original mission while another project is in front", async (t) => {
  const f = await fixture(t);
  await f.runtime.completeOwnerTurn("Work on the other project.", undefined, "other");
  const foregroundTurn = f.state.latestOwnerTurnId();
  const otherCommitment = f.core.recordCommitment(foregroundTurn!, {
    outcome: "Other project private work", criteria: [{ kind: "owner-judgment" }],
  });
  const before = f.state.readOwnerConversation()!.messages;
  const beforeOther = f.state.readOwnerConversation("other")!.messages;
  f.onContinuation(async (request) => {
    assert.equal(request.ownerInput, "Research the original project.");
    assert.equal(request.continuation?.mission, request.ownerInput);
    assert.equal(request.nativeTools?.cwd, f.project);
    assert.equal(request.authorityActions, undefined);
    assert.equal(request.harnessActions, undefined);
    assert.equal(request.commitmentActions?.recordOwnerVerdict, undefined);
    assert.equal(request.commitmentActions?.cancel, undefined);
    assert.equal(request.commitments?.some((work) => work.id === otherCommitment.id), false);
    assert.deepEqual(request.workers?.map((worker) => worker.id), [f.worker.id]);
    assert.deepEqual(request.workerQuestions?.map((question) => question.id), [f.question.id]);
    assert.deepEqual(request.conversation, before);
    await request.workerActions!.answer!(f.question.id, { scope: ["src/lead-agent-runtime"] });
  });

  const result = await f.runtime.completeContinuation(f.candidate);
  assert.equal(result, "The Worker has its answer.");
  assert.deepEqual(f.answers, [{ questionId: f.question.id, ownerTurnId: f.origin }]);
  assert.equal(f.state.readWorkerQuestion(f.question.id)?.status, "delivered");
  assert.equal(f.state.latestOwnerTurnId(), foregroundTurn);
  const messages = f.state.readOwnerConversation()!.messages;
  assert.equal(messages.filter((message) => message.role === "owner").length, 1);
  assert.equal(messages.length, before.length + 1);
  assert.deepEqual(f.state.readOwnerConversation("other")!.messages, beforeOther);
  const receipt = f.state.readLeadContinuations()[0]!;
  assert.equal(receipt.status, "completed");
  assert.equal(f.state.ownerMessage(receipt.id), undefined);
  assert.equal(f.state.leadAgentResponse(f.origin), "I am working on it.");
  assert.equal(f.state.leadAgentResponse(receipt.id), result);
  assert.equal(await f.runtime.completeContinuation(f.candidate), undefined);
  assert.equal(f.autonomousCalls, 1);
});

test("a claimed continuation interrupted by Owner steering fails once and never replays", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  f.onContinuation(async (request) => {
    assert.ok(request.signal);
    entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
    });
  });
  const pending = f.runtime.completeContinuation(f.candidate, controller.signal);
  await entered.promise;
  const rejected = assert.rejects(pending, /interrupted/i);
  controller.abort(new Error("Owner is steering."));
  await rejected;
  const receipt = f.state.readLeadContinuations()[0]!;
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.failureKind, "aborted");
  assert.equal(f.state.leadAgentResponse(receipt.id), undefined);
  assert.equal(f.state.readWorkerQuestion(f.question.id)?.status, "open");
  assert.equal(f.state.readOwnerConversation()!.messages.filter((message) => message.role === "owner").length, 1);
  assert.equal(await f.runtime.completeContinuation(f.candidate), undefined);
  assert.equal(f.autonomousCalls, 1);
  assert.deepEqual(pendingLeadContinuations(f.state), []);
});

test("an already aborted continuation never claims the observation or calls the Model", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await f.runtime.completeContinuation(f.candidate, controller.signal), undefined);
  assert.equal(f.autonomousCalls, 0);
  assert.deepEqual(f.state.readLeadContinuations(), []);
  assert.equal(pendingLeadContinuations(f.state)[0]?.eventKey, f.candidate.eventKey);
});

test("production continuation exposes Worker tools but omits Owner-only authority and configuration tools", async (t) => {
  const f = await fixture(t);
  let exposedTools: string[] = [];
  const model = await startLocalModel((call, body) => {
    if (call === 1) {
      assert.equal(f.state.readLeadContinuations()[0]?.status, "started");
      exposedTools = (body as { tools: Array<{ function: { name: string } }> })
        .tools.map((tool) => tool.function.name);
      return { toolCall: {
        id: "answer-worker", name: "answer_worker_question",
        arguments: { questionId: f.question.id, answers: { scope: ["src/lead-agent-runtime"] } },
      } };
    }
    return "The Worker can continue.";
  });
  t.after(() => model.close());
  const configuration = f.state.readOwnerConversation()!;
  f.state.replaceOwnerConfiguration({
    ...configuration,
    modelSelection: {
      provider: "local-openai", model: "owner-model",
      api: "openai-completions", baseUrl: model.baseUrl,
    },
  });
  const runtime = createLeadAgentRuntime({
    state: f.state, adapter: new PiAgentTurnAdapter(), workerSupervisor: f.supervisor,
  });
  assert.equal(await runtime.completeContinuation(f.candidate), "The Worker can continue.");
  for (const name of [
    "record_standing_order", "revoke_standing_order", "configure_worker_harness",
    "record_owner_verdict", "cancel_work_item",
  ]) assert.equal(exposedTools.includes(name), false, `${name} requires an actual Owner turn.`);
  assert.ok(exposedTools.includes("answer_worker_question"));
  assert.ok(exposedTools.includes("delegate_read_only_codex"));
  assert.ok(exposedTools.includes("read"));
  assert.equal(f.state.readWorkerQuestion(f.question.id)?.status, "delivered");
});
