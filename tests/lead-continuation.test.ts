import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { openAuthoritativeState, type AuthoritativeState } from "../src/authoritative-state/index.ts";
import { pendingLeadContinuations, reconcileLeadContinuations } from "../src/lead-continuation/index.ts";
import { createOrchestrationCore, type Commitment, type WorkerSession } from "../src/orchestration-core/index.ts";
import type { TargetProjectOperationAttempt, TargetProjectOperationEffectIntent } from "../src/target-project-operations/index.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cmd-riker-continuation-"));
  let state = openAuthoritativeState(directory);
  t.after(async () => { state.close(); await rm(directory, { recursive: true, force: true }); });
  const project = join(directory, "project");
  const otherProject = join(directory, "other-project");
  state.initialize({
    targetProject: { path: project },
    projects: [{ name: "Other", path: otherProject }],
    modelSelection: { provider: "local-openai", model: "owner-model", api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" },
    modelPolicyRevision: "owner-policy-1",
  });
  const ownerTurnId = state.appendOwnerMessage("Inspect the project and answer routine Worker questions.");
  state.appendLeadAgentMessage(ownerTurnId, "I will inspect it.");
  return {
    get state() { return state; }, project, otherProject, ownerTurnId,
    reopen() { state.close(); state = openAuthoritativeState(directory); return state; },
  };
}

function worker(state: AuthoritativeState, project: string, ownerTurnId?: string, commitmentId?: string): WorkerSession {
  const created = createOrchestrationCore(state).delegateReadOnlyWorker({
    objective: "Inspect one module.", prompt: "Read and report.", targetProjectPath: project,
    ...(ownerTurnId ? { ownerTurnId } : {}), modelSelection: { provider: "openai", nativeHarness: "codex", model: "gpt-5.6-sol" },
    ...(commitmentId ? { commitmentId } : {}),
    modelPolicyRevision: "worker-policy-1",
  });
  const current = { ...created.workerSession, state: "running" as const };
  state.appendWorkerState({ workerSession: current, executionAttempt: { ...created.executionAttempt, status: "running" } });
  return current;
}

function question(state: AuthoritativeState, current: WorkerSession) {
  return createOrchestrationCore(state).observeWorkerQuestion({
    workerSessionId: current.id, executionAttemptId: current.currentExecutionAttemptId,
    providerRequestId: 1, itemId: "question-1",
    questions: [{ id: "scope", question: "Which module?", isOther: true }],
  });
}

function complete(state: AuthoritativeState, current: WorkerSession): void {
  state.appendWorkerState({
    workerSession: { ...current, state: "completed" },
    executionAttempt: { ...state.readWorkerExecutionAttempt(current.currentExecutionAttemptId)!, status: "completed" },
  });
}

test("a durable question produces one independently attributed Lead response, never an Owner message", async (t) => {
  const f = await fixture(t);
  const current = worker(f.state, f.project, f.ownerTurnId);
  question(f.state, current);
  const [candidate] = pendingLeadContinuations(f.state);
  assert.ok(candidate);
  assert.equal(candidate.kind, "worker-question");
  const receipt = f.state.claimLeadContinuation(candidate)!;
  assert.equal(f.state.claimLeadContinuation(candidate), undefined);
  assert.deepEqual(pendingLeadContinuations(f.state), []);
  assert.equal(f.state.ownerMessage(receipt.id), undefined);
  f.state.appendLeadContinuationMessageWithAccounts(receipt.id, "I answered the Worker.", { selfRepairs: [], commitments: [] });
  f.state.settleLeadContinuation(receipt.id, "completed");
  const state = f.reopen();
  assert.equal(state.leadAgentResponse(f.ownerTurnId), "I will inspect it.");
  assert.equal(state.leadAgentResponse(receipt.id), "I answered the Worker.");
  assert.equal(state.readOwnerConversation()!.messages.filter((message) => message.role === "owner").length, 1);
  assert.deepEqual(pendingLeadContinuations(state), []);
  assert.equal(state.readLeadContinuation(receipt.id)?.status, "completed");
});

test("restart preserves unseen terminal events but never replays interrupted inference or mistakes its Owner response for completion", async (t) => {
  const f = await fixture(t);
  const first = worker(f.state, f.project, f.ownerTurnId);
  complete(f.state, first);
  const receipt = f.state.claimLeadContinuation(pendingLeadContinuations(f.state)[0]!)!;
  const attempt = createOrchestrationCore(f.state).startLeadTurnAttempt({
    ownerTurnId: f.ownerTurnId, continuationId: receipt.id,
    modelSelection: f.state.readOwnerConversation()!.modelSelection, modelPolicyRevision: "owner-policy-1",
  });
  const second = worker(f.state, f.project, f.ownerTurnId);
  complete(f.state, second);
  const state = f.reopen();
  createOrchestrationCore(state).reconcileInterruptedCommitments();
  assert.equal(state.readLeadTurnAttempt(attempt.id)?.failureKind, "continuity-lost");
  assert.equal(reconcileLeadContinuations(state)[0]?.id, receipt.id);
  assert.equal(state.readLeadContinuation(receipt.id)?.failureKind, "continuity-lost");
  assert.equal(pendingLeadContinuations(state).length, 1);
  assert.equal(pendingLeadContinuations(state)[0]?.workerSessionId, second.id);
  assert.deepEqual(reconcileLeadContinuations(state), []);
});

test("restart settles the unique persisted continuation response and aborted observations stay consumed", async (t) => {
  const f = await fixture(t);
  const first = worker(f.state, f.project, f.ownerTurnId);
  complete(f.state, first);
  const receipt = f.state.claimLeadContinuation(pendingLeadContinuations(f.state)[0]!)!;
  f.state.appendLeadContinuationMessageWithAccounts(receipt.id, "Inspection completed.", { selfRepairs: [], commitments: [] });
  assert.deepEqual(reconcileLeadContinuations(f.reopen()), []);
  assert.equal(f.state.readLeadContinuation(receipt.id)?.status, "completed");
  const second = worker(f.state, f.project, f.ownerTurnId);
  complete(f.state, second);
  const aborted = f.state.claimLeadContinuation(pendingLeadContinuations(f.state)[0]!)!;
  f.state.settleLeadContinuation(aborted.id, "failed", "aborted");
  assert.deepEqual(pendingLeadContinuations(f.reopen()), []);
  assert.throws(() => f.state.appendLeadContinuationMessageWithAccounts(aborted.id, "Too late.", { selfRepairs: [], commitments: [] }), /active durable receipt/);
});

test("Owner-reserved questions, stale attempts, missing origins and mismatched projects never start autonomous turns", async (t) => {
  const f = await fixture(t);
  const reserved = worker(f.state, f.project, f.ownerTurnId);
  const reservedQuestion = question(f.state, reserved);
  createOrchestrationCore(f.state).reserveWorkerQuestionForOwner(reservedQuestion.id, "The Owner reserved product scope.");
  const stale = worker(f.state, f.project, f.ownerTurnId);
  question(f.state, stale);
  f.state.appendWorkerSessionSnapshots([{ ...stale, currentExecutionAttemptId: "unknown-new-attempt", state: "waiting-question" }]);
  const legacy = worker(f.state, f.project, f.ownerTurnId);
  const { ownerTurnId: _origin, ...assignment } = legacy.assignment;
  complete(f.state, { ...legacy, assignment });
  complete(f.state, worker(f.state, f.otherProject, f.ownerTurnId));
  assert.deepEqual(pendingLeadContinuations(f.state), []);
});

test("originating session wins over the foreground session and claims reject forged attribution", async (t) => {
  const f = await fixture(t);
  const current = worker(f.state, f.project, f.ownerTurnId);
  complete(f.state, current);
  f.state.appendOwnerSessionSnapshots([{ id: "other", projectPath: f.otherProject, name: "Other", createdAt: new Date().toISOString(), state: "active" }]);
  const otherTurn = f.state.appendOwnerMessage("Work in the other project.", "other");
  const candidate = pendingLeadContinuations(f.state)[0]!;
  assert.equal(candidate.sessionId, "primary");
  assert.equal(candidate.targetProjectPath, f.project);
  assert.throws(() => f.state.claimLeadContinuation({ ...candidate, ownerTurnId: otherTurn, sessionId: "other" }), /origin/);
  const receipt = f.state.claimLeadContinuation(candidate)!;
  f.state.appendLeadContinuationMessageWithAccounts(receipt.id, "Original project finished.", { selfRepairs: [], commitments: [] });
  assert.equal(f.state.readOwnerConversation("other")!.messages.length, 1);
  assert.equal(f.state.readOwnerConversation("primary")!.messages.at(-1)?.turnId, receipt.id);
});

test("effectful completion waits for its exact Verification result", async (t) => {
  const f = await fixture(t);
  const orchestration = createOrchestrationCore(f.state);
  const commitment = orchestration.recordCommitment(f.ownerTurnId, { outcome: "Deliver the change.", criteria: [{ kind: "target-project-operation", operation: "test", description: "Tests pass." }] });
  const created = orchestration.delegateEffectfulWorker({
    ownerTurnId: f.ownerTurnId, objective: "Implement change.", prompt: "Implement change.", targetProjectPath: f.project,
    modelSelection: { provider: "openai", nativeHarness: "codex", model: "gpt-5.6-sol" }, modelPolicyRevision: "worker-policy-1",
    commitmentId: commitment.id, targets: ["src/index.ts"], timeoutMs: 60_000,
    checkoutIsolation: { root: f.project, baselineCommit: "a".repeat(40), isolation: { kind: "worktree" } },
    verification: { operation: "test", workingDirectory: f.project, timeoutMs: 60_000 },
  });
  complete(f.state, created.workerSession);
  const workerEffect = f.state.readEffectIntent(created.executionAttempt.effectIntentId!)!;
  f.state.appendWorkerState({ effectIntent: { ...workerEffect, status: "succeeded" } });
  assert.deepEqual(pendingLeadContinuations(f.state), []);
  f.state.appendWorkerState({
    workerSession: { ...created.workerSession, state: "reconciling" },
    effectIntent: { ...workerEffect, status: "unknown" },
  });
  assert.equal(pendingLeadContinuations(f.state)[0]?.kind, "worker-terminal");
  complete(f.state, created.workerSession);
  f.state.appendWorkerState({ effectIntent: { ...workerEffect, status: "succeeded" } });
  assert.deepEqual(pendingLeadContinuations(f.state), []);
  const now = new Date().toISOString();
  const attempt: TargetProjectOperationAttempt = {
    id: "verification", commitmentId: commitment.id, effectIntentId: "verification-effect", operation: "test",
    checkout: f.project, workingDirectory: f.project, timeoutMs: 60_000, startedAt: now,
    discovery: { status: "unavailable", diagnostic: "Task unavailable." }, status: "unavailable",
    causedByWorker: { workerSessionId: created.workerSession.id, executionAttemptId: created.executionAttempt.id, generation: 1 },
    result: { operationAttemptId: "verification", commitmentId: commitment.id, effectIntentId: "verification-effect", operation: "test", status: "unavailable", discovery: { status: "unavailable", diagnostic: "Task unavailable." }, affectedArtifacts: [], diagnostics: [], uncertainty: null, startedAt: now, completedAt: now },
  };
  const effect: TargetProjectOperationEffectIntent = {
    id: attempt.effectIntentId, commitmentId: commitment.id, kind: "target-project-operation", operationAttemptId: attempt.id,
    expectedEffect: "Run Verification.", authorizedWriteRootKey: f.project.toLowerCase(), retryRule: "Do not replay.", status: "rejected",
    authorization: { kind: "lead-agent-command-authority", commitmentId: commitment.id, targetProjectPath: f.project, validatedAt: now },
  };
  f.state.startTargetProjectOperation(attempt, effect);
  assert.equal(pendingLeadContinuations(f.state)[0]?.kind, "worker-terminal");
});

test("continuation response and account delivery commit atomically", async (t) => {
  const f = await fixture(t);
  const current = worker(f.state, f.project, f.ownerTurnId);
  complete(f.state, current);
  const receipt = f.state.claimLeadContinuation(pendingLeadContinuations(f.state)[0]!)!;
  const commitment = createOrchestrationCore(f.state).recordCommitment(f.ownerTurnId, { outcome: "Inspection delivered.", criteria: [{ kind: "owner-judgment" }] });
  const accepted = { ...commitment, state: "accepted" as const, outcomeAccount: { content: "Inspection delivered.", recordedAt: new Date().toISOString() } };
  f.state.appendCommitmentSnapshots([accepted]);
  const delivered = { ...accepted, outcomeAccount: { ...accepted.outcomeAccount, deliveredAt: new Date().toISOString() } };
  assert.throws(() => f.state.appendLeadContinuationMessageWithAccounts(receipt.id, "Delivered.", { selfRepairs: [], commitments: [{ ...delivered, outcome: "Changed unexpectedly." }] }), /current pending account/);
  assert.equal(f.state.leadAgentResponse(receipt.id), undefined);
  assert.equal(f.state.readCommitment(commitment.id)?.outcomeAccount?.deliveredAt, undefined);
  f.state.appendLeadContinuationMessageWithAccounts(receipt.id, "Delivered.", { selfRepairs: [], commitments: [delivered] });
  assert.equal(f.reopen().leadAgentResponse(receipt.id), "Delivered.");
  assert.ok(f.state.readCommitment(commitment.id)?.outcomeAccount?.deliveredAt);
});

test("only a later actual Owner response in the originating session acknowledges a failed continuation", async (t) => {
  const f = await fixture(t);
  const current = worker(f.state, f.project, f.ownerTurnId);
  complete(f.state, current);
  const receipt = f.state.claimLeadContinuation(pendingLeadContinuations(f.state)[0]!)!;
  f.state.settleLeadContinuation(receipt.id, "failed", "turn-failed");
  assert.equal(f.state.hasOwnerResponseAfterLeadContinuation(receipt.id), false);
  f.state.appendOwnerSessionSnapshots([{ id: "other", name: "Other", projectPath: f.otherProject, createdAt: new Date().toISOString(), state: "active" }]);
  const otherTurn = f.state.appendOwnerMessage("Continue here.", "other");
  f.state.appendLeadAgentMessage(otherTurn, "Continuing the other project.");
  assert.equal(f.state.hasOwnerResponseAfterLeadContinuation(receipt.id), false);
  const anotherWorker = worker(f.state, f.project, f.ownerTurnId);
  complete(f.state, anotherWorker);
  const anotherReceipt = f.state.claimLeadContinuation(pendingLeadContinuations(f.state)[0]!)!;
  f.state.appendLeadContinuationMessageWithAccounts(anotherReceipt.id, "Another Worker completed.", { selfRepairs: [], commitments: [] });
  assert.equal(f.state.hasOwnerResponseAfterLeadContinuation(receipt.id), false);
  const ownerTurn = f.state.appendOwnerMessage("Resume the interrupted work.");
  assert.equal(f.state.hasOwnerResponseAfterLeadContinuation(receipt.id), false);
  f.state.appendLeadAgentMessage(ownerTurn, "I reconciled the interrupted work.");
  assert.equal(f.state.hasOwnerResponseAfterLeadContinuation(receipt.id), true);
});

test("late observations cannot revive cancelled, superseded, paused, reserved or Owner-verified Work Items", async (t) => {
  const f = await fixture(t);
  const stopped: Array<Partial<Commitment>> = [
    { state: "cancelled" },
    { state: "superseded" },
    { condition: { kind: "paused", reason: "Owner paused this work.", nextAction: "Wait for the Owner." } },
    { condition: { kind: "blocked", ownerAttention: "owner-reserved-decision", reason: "Scope needs the Owner.", nextAction: "Wait for the Owner." } },
    { state: "accepted", acceptance: { authority: "owner", basis: "owner-verdict", ownerTurnId: f.ownerTurnId, acceptedAt: new Date().toISOString(), ownerVerdictQuote: "This is verified." } },
  ];
  for (const patch of stopped) {
    const commitment = createOrchestrationCore(f.state).recordCommitment(f.ownerTurnId, {
      outcome: "Inspect one result.", criteria: [{ kind: "owner-judgment" }],
    });
    const current = worker(f.state, f.project, f.ownerTurnId, commitment.id);
    question(f.state, current);
    const candidate = pendingLeadContinuations(f.state)[0]!;
    assert.ok(candidate);
    f.state.appendCommitmentSnapshots([{ ...commitment, ...patch }]);
    assert.equal(f.state.claimLeadContinuation(candidate), undefined);
    complete(f.state, current);
    assert.deepEqual(pendingLeadContinuations(f.state), []);
  }
});

test("failed work and pending Review remain actionable; accepted Lead delivery can still be reported", async (t) => {
  const f = await fixture(t);
  const actionable: Array<Partial<Commitment>> = [
    { condition: { kind: "blocked", reason: "Verification failed.", nextAction: "Investigate and repair." } },
    { condition: { kind: "blocked", reason: "Review needs repair.", nextAction: "Repair the findings." }, review: { required: true, reasons: ["public-module"], status: "changes-requested", findings: [] } },
    { state: "accepted", acceptance: { authority: "lead-agent", basis: "objective-criteria", acceptedAt: new Date().toISOString() }, outcomeAccount: { content: "Delivered and verified." } },
  ];
  for (const patch of actionable) {
    const commitment = createOrchestrationCore(f.state).recordCommitment(f.ownerTurnId, {
      outcome: "Deliver one result.", criteria: [{ kind: "owner-judgment" }],
    });
    const current = worker(f.state, f.project, f.ownerTurnId, commitment.id);
    complete(f.state, current);
    f.state.appendCommitmentSnapshots([{ ...commitment, ...patch }]);
    assert.equal(pendingLeadContinuations(f.state).filter((candidate) => candidate.workerSessionId === current.id).length, 1);
  }
});

test("Owner-cancelled Workers do not trigger replacement while deadline failure remains actionable", async (t) => {
  const f = await fixture(t);
  const current = worker(f.state, f.project, f.ownerTurnId);
  complete(f.state, current);
  f.state.appendWorkerSessionSnapshots([{
    ...current, state: "failed", cancellation: { kind: "owner", requestedByOwnerTurnId: f.ownerTurnId, requestedAt: new Date().toISOString(), reason: "Stop this Worker." },
  }]);
  assert.deepEqual(pendingLeadContinuations(f.state), []);
  f.state.appendWorkerSessionSnapshots([{
    ...current, state: "failed", cancellation: { kind: "deadline", requestedAt: new Date().toISOString(), reason: "Deadline exceeded." },
  }]);
  assert.equal(pendingLeadContinuations(f.state)[0]?.workerSessionId, current.id);
});

test("continuation project matching respects the host filesystem case convention", async (t) => {
  const f = await fixture(t);
  const current = worker(f.state, f.project.toUpperCase(), f.ownerTurnId);
  complete(f.state, current);
  assert.equal(pendingLeadContinuations(f.state).length, process.platform === "win32" ? 1 : 0);
});
