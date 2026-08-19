import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import {
  createOrchestrationCore,
  type OrchestrationCore,
  type WorkerNativeCapabilities,
} from "../src/orchestration-core/index.ts";
import {
  createTargetProjectOperations,
  type TaskCli,
} from "../src/target-project-operations/index.ts";

test("an implementing Worker hands one bounded assignment to an independent reviewer", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-worker-coordination-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const checkout = join(stateDirectory, "target-project");
  await mkdir(checkout);
  await writeFile(join(checkout, "Taskfile.yml"), "version: '3'\ntasks:\n  test:\n    cmds: ['echo ok']\n");
  await writeFile(join(checkout, "cmd-riker.operations.json"), JSON.stringify({
    version: 1,
    operations: {
      test: { task: "test", platforms: [declaredPlatform()], artifacts: [] },
    },
  }));
  let state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration(checkout));
  const orchestration = createOrchestrationCore(state);
  const ownerTurnId = state.appendOwnerMessage("Implement and independently review the public module.");
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The public module change passes tests and independent Review.",
    criteria: [{
      kind: "target-project-operation",
      description: "The declared test operation succeeds.",
      operation: "test",
    }],
    review: { required: true, reasons: ["public-module", "objective-check-gap"] },
  });
  const implementation = orchestration.delegateEffectfulWorker({
    objective: "Implement the public module change.",
    prompt: "Change only src/public.ts.",
    targetProjectPath: checkout,
    modelSelection: { provider: "openai", model: "gpt-5.6-sol", nativeHarness: "codex" },
    modelPolicyRevision: "worker-policy-1",
    commitmentId: commitment.id,
    targets: ["src/public.ts"],
    timeoutMs: 60_000,
    checkoutIsolation: {
      root: checkout,
      baselineCommit: "a".repeat(40),
      isolation: { kind: "branch", branch: "codex/public-change" },
    },
    verification: { operation: "test", workingDirectory: checkout, timeoutMs: 30_000 },
  });
  startWorker(orchestration, implementation.workerSession.id, implementation.executionAttempt.id, false);
  assert.equal(orchestration.observeWorkerTerminal({
    workerSessionId: implementation.workerSession.id,
    executionAttemptId: implementation.executionAttempt.id,
    status: "completed",
    processGone: true,
    observedChanges: ["src/public.ts"],
    reportedOutcome: {
      status: "completed",
      summary: "Implemented the public module change.",
      affectedArtifacts: ["src/public.ts"],
      verificationResults: ["Implementation is ready for host Verification and Review."],
    },
  }), "settled");

  const review = orchestration.delegateReviewWorker({
    implementationWorkerSessionId: implementation.workerSession.id,
    prompt: "Check the public interface and gaps in objective tests.",
    modelSelection: { provider: "anthropic", model: "claude-sonnet-5", nativeHarness: "claude" },
    modelPolicyRevision: "review-policy-1",
  });
  assert.notEqual(review.workerSession.id, implementation.workerSession.id);
  assert.equal(review.workerSession.assignment.readOnly, true);
  assert.deepEqual(review.workerSession.assignment.coordination, {
    role: "reviewer",
    reviewOfWorkerSessionId: implementation.workerSession.id,
  });
  assert.match(review.workerSession.assignment.prompt, /criterion, evidence, or risk/);
  assert.equal(orchestration.workerSessionsView().length, 2);
  assert.equal(orchestration.coordinationMessagesView()[0]?.kind, "review-request");

  const taskCli: TaskCli = {
    async inspect() {
      return {
        version: "Task version: v3.53.1",
        taskfile: join(checkout, "Taskfile.yml"),
        tasks: ["test"],
      };
    },
    async run() {
      return { exitCode: 0, timedOut: false };
    },
  };
  const operations = createTargetProjectOperations(state, taskCli, {
    async verify() {
      return { root: checkout };
    },
  });
  const verificationResult = await operations.execute(
    orchestration.workerVerificationRequest(
      implementation.workerSession.id,
      implementation.executionAttempt.id,
    ),
  );
  assert.equal(verificationResult.status, "succeeded", JSON.stringify(verificationResult));
  orchestration.observeWorkerVerificationResult(
    implementation.workerSession.id,
    implementation.executionAttempt.id,
    verificationResult,
  );
  assert.equal(state.readCommitment(commitment.id)?.state, "verifying");

  startWorker(orchestration, review.workerSession.id, review.executionAttempt.id, true);
  orchestration.observeWorkerTerminal({
    workerSessionId: review.workerSession.id,
    executionAttemptId: review.executionAttempt.id,
    status: "completed",
    processGone: true,
    reportedOutcome: {
      status: "completed",
      summary: "Independent Review completed.",
      affectedArtifacts: [],
      verificationResults: ["Reviewed the public interface and test evidence."],
      reviewFindings: [{
        basis: "criterion",
        disposition: "must-fix",
        summary: "The public contract is incomplete.",
        evidence: "The required export is absent.",
      }],
    },
  });
  assert.equal(state.readCommitment(commitment.id)?.review?.status, "changes-requested");
  assert.equal(state.readCommitment(commitment.id)?.state, "active");
  assert.equal(state.readCommitment(commitment.id)?.condition?.kind, "blocked");
  assert.equal(orchestration.coordinationMessagesView()[1]?.kind, "review-finding");

  const repairTurn = state.appendOwnerMessage("Repair and re-review the must-fix finding.");
  orchestration.resumeCommitment(commitment.id, repairTurn);
  assert.equal(state.readCommitment(commitment.id)?.review?.status, "changes-requested");
  const repair = orchestration.delegateEffectfulWorker({
    objective: "Repair the public module contract.",
    prompt: "Add the missing export in src/public.ts.",
    targetProjectPath: checkout,
    modelSelection: { provider: "openai", model: "gpt-5.6-sol", nativeHarness: "codex" },
    modelPolicyRevision: "worker-policy-1",
    commitmentId: commitment.id,
    targets: ["src/public.ts"],
    timeoutMs: 60_000,
    checkoutIsolation: {
      root: checkout,
      baselineCommit: "b".repeat(40),
      isolation: { kind: "branch", branch: "codex/public-repair" },
    },
    verification: { operation: "test", workingDirectory: checkout, timeoutMs: 30_000 },
  });
  assert.deepEqual(repair.workerSession.assignment.coordination, {
    role: "implementer",
    repairOfReviewFindingIds: [state.readCommitment(commitment.id)!.review!.findings[0]!.id],
  });
  startWorker(orchestration, repair.workerSession.id, repair.executionAttempt.id, false);
  orchestration.observeWorkerTerminal({
    workerSessionId: repair.workerSession.id,
    executionAttemptId: repair.executionAttempt.id,
    status: "completed",
    processGone: true,
    observedChanges: ["src/public.ts"],
    reportedOutcome: {
      status: "completed",
      summary: "Repaired the public contract.",
      affectedArtifacts: ["src/public.ts"],
      verificationResults: ["Repair is ready for refreshed Verification."],
    },
  });
  const repairVerification = await operations.execute(
    orchestration.workerVerificationRequest(repair.workerSession.id, repair.executionAttempt.id),
  );
  orchestration.observeWorkerVerificationResult(
    repair.workerSession.id,
    repair.executionAttempt.id,
    repairVerification,
  );
  assert.equal(state.readCommitment(commitment.id)?.review?.status, "pending");
  assert.equal(
    state.readCommitment(commitment.id)?.review?.implementationWorkerSessionId,
    repair.workerSession.id,
  );
  assert.throws(
    () => orchestration.delegateReviewWorker({
      implementationWorkerSessionId: implementation.workerSession.id,
      prompt: "Re-review stale implementation.",
      modelSelection: { provider: "anthropic", model: "claude-sonnet-5", nativeHarness: "claude" },
      modelPolicyRevision: "review-policy-1",
    }),
    /refreshed Verification/i,
  );
  const reReview = orchestration.delegateReviewWorker({
    implementationWorkerSessionId: repair.workerSession.id,
    prompt: "Target the repaired public contract.",
    modelSelection: { provider: "anthropic", model: "claude-sonnet-5", nativeHarness: "claude" },
    modelPolicyRevision: "review-policy-1",
  });
  startWorker(orchestration, reReview.workerSession.id, reReview.executionAttempt.id, true);
  orchestration.observeWorkerTerminal({
    workerSessionId: reReview.workerSession.id,
    executionAttemptId: reReview.executionAttempt.id,
    status: "completed",
    processGone: true,
    reportedOutcome: {
      status: "completed",
      summary: "Targeted re-review passed.",
      affectedArtifacts: [],
      verificationResults: ["The repaired contract satisfies the cited criterion."],
      reviewFindings: [],
    },
  });
  assert.equal(state.readCommitment(commitment.id)?.state, "accepted", JSON.stringify(state.readCommitment(commitment.id)));
  assert.throws(
    () => orchestration.recordCoordinationMessage({
      fromWorkerSessionId: repair.workerSession.id,
      toWorkerSessionId: reReview.workerSession.id,
      commitmentId: commitment.id,
      kind: "factual-question",
      summary: "Try to assign a question after Review completed.",
      evidence: ["The recipient is terminal."],
    }),
    /terminal Worker Session/i,
  );

  const unrelatedTurn = state.appendOwnerMessage("Track an unrelated outcome.");
  const unrelated = orchestration.recordCommitment(unrelatedTurn, {
    outcome: "An unrelated answer is produced.",
    criteria: [{ kind: "response-includes", description: "The answer exists.", expectedText: "answer" }],
  });
  const outsider = orchestration.delegateReadOnlyWorker({
    objective: "Inspect unrelated evidence.",
    prompt: "Inspect only.",
    targetProjectPath: checkout,
    modelSelection: { provider: "openai", model: "gpt-5.6-sol", nativeHarness: "codex" },
    modelPolicyRevision: "worker-policy-1",
    commitmentId: unrelated.id,
  });
  const workerCount = orchestration.workerSessionsView().length;
  assert.throws(
    () => orchestration.recordCoordinationMessage({
      fromWorkerSessionId: review.workerSession.id,
      toWorkerSessionId: outsider.workerSession.id,
      commitmentId: commitment.id,
      kind: "evidence",
      summary: "Try to widen the unrelated assignment.",
      evidence: ["This must be rejected."],
    }),
    /cannot create work or expand assignment scope/i,
  );
  assert.equal(orchestration.workerSessionsView().length, workerCount);

  state.close();
  state = openAuthoritativeState(stateDirectory);
  assert.equal(state.readCoordinationMessages().length, 3);
  assert.equal(state.readCommitment(commitment.id)?.review?.findings.length, 1);
  state.close();
});

function startWorker(
  orchestration: OrchestrationCore,
  workerSessionId: string,
  executionAttemptId: string,
  readOnly: boolean,
): void {
  orchestration.claimWorkerLaunch(workerSessionId, executionAttemptId);
  const process = { pid: readOnly ? 5102 : 5101, startedAt: "2026-08-19T10:00:00.000Z" };
  orchestration.observeWorkerProcessStarted({
    workerSessionId,
    executionAttemptId,
    process,
    harnessVersion: readOnly ? "claude-version" : "codex-version",
    protocolSchemaSha256: readOnly ? "claude-schema" : "codex-schema",
  });
  if (!readOnly) orchestration.claimWorkerEffectDispatch(workerSessionId, executionAttemptId);
  orchestration.observeWorkerAttemptStarted({
    workerSessionId,
    executionAttemptId,
    providerSessionId: readOnly ? "claude-session" : "codex-session",
    nativeExecutionId: readOnly ? "claude-execution" : "codex-execution",
    process,
    harnessVersion: readOnly ? "claude-version" : "codex-version",
    capabilities: capabilities(readOnly),
    ...(!readOnly ? { writeIsolation: "authorized-write-root-enforced" as const } : {}),
  });
}

function capabilities(readOnly: boolean): WorkerNativeCapabilities {
  const protocolSchemaSha256 = readOnly ? "claude-schema" : "codex-schema";
  return {
    readOnly,
    nativeQuestions: !readOnly,
    cancellation: true,
    providerSessionResume: false,
    providerSessionLoad: "unavailable",
    providerSessionDeletion: false,
    nativeChildControl: false,
    exactExecutionResume: "live-connection-only",
    protocolSchemaSha256,
    ...(!readOnly ? { writeIsolation: "authorized-write-root-enforced" as const } : {}),
  };
}

function declaredPlatform(): "windows" | "linux" | "darwin" {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
}

function ownerConfiguration(checkout: string) {
  return {
    targetProject: { path: checkout },
    modelSelection: {
      provider: "local-openai" as const,
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "lead-policy-1",
  };
}
