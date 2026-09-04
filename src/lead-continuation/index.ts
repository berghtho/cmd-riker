import { resolve } from "node:path";

import type { AuthoritativeState } from "../authoritative-state/index.ts";

export type LeadContinuationCandidate = {
  eventKey: string;
  kind: "worker-question" | "worker-terminal";
  ownerTurnId: string;
  sessionId: string;
  targetProjectPath: string;
  workerSessionId: string;
  executionAttemptId: string;
  questionId?: string;
};

export type LeadContinuation = LeadContinuationCandidate & {
  id: string;
  status: "started" | "completed" | "failed";
  createdAt: string;
  failureKind?: "aborted" | "continuity-lost" | "model-unavailable" | "turn-failed";
};

/** Current durable observations are the queue; receipts make each observation single-use. */
export function pendingLeadContinuations(state: AuthoritativeState): LeadContinuationCandidate[] {
  const claimed = new Set(state.readLeadContinuations().map((entry) => entry.eventKey));
  const sessions = new Map(state.readOwnerSessions().map((session) => [session.id, session]));
  const operations = state.readTargetProjectOperationAttempts();
  const questions = state.readWorkerQuestions();
  const result: LeadContinuationCandidate[] = [];
  for (const worker of state.readWorkerSessions()) {
    const commitment = worker.assignment.commitmentId
      ? state.readCommitment(worker.assignment.commitmentId)
      : undefined;
    if (worker.assignment.commitmentId && !commitment) continue;
    // An observation does not revive work the Owner stopped or reserved.
    if (commitment && (
      commitment.state === "cancelled" || commitment.state === "superseded" ||
      commitment.condition?.kind === "paused" ||
      commitment.condition?.ownerAttention === "owner-reserved-decision" ||
      (commitment.state === "accepted" && commitment.acceptance?.authority === "owner")
    )) continue;
    if (worker.cancellation?.kind === "owner" || worker.state === "cancelled") continue;
    const ownerTurnId = worker.assignment.ownerTurnId ?? commitment?.createdByOwnerTurnId;
    if (!ownerTurnId || state.ownerMessage(ownerTurnId) === undefined) continue;
    const sessionId = state.ownerSessionIdForTurn(ownerTurnId);
    if (!sessionId) continue;
    const session = sessions.get(sessionId);
    if (!session || session.state !== "active") continue;
    const conversation = state.readOwnerConversation(sessionId);
    if (!conversation) continue;
    const targetProjectPath = session.projectPath ?? conversation.targetProject.path;
    if (pathKey(targetProjectPath) !== pathKey(worker.assignment.targetProjectPath)) continue;
    const executionAttemptId = worker.currentExecutionAttemptId;
    const attempt = state.readWorkerExecutionAttempt(executionAttemptId);
    if (!attempt || attempt.workerSessionId !== worker.id) continue;
    const origin = { ownerTurnId, sessionId, targetProjectPath, workerSessionId: worker.id, executionAttemptId };
    for (const question of questions) {
      if (question.workerSessionId !== worker.id || question.executionAttemptId !== executionAttemptId ||
          question.status !== "open" || question.ownerAttention || worker.state !== "waiting-question") continue;
      const eventKey = `question:${question.id}`;
      if (!claimed.has(eventKey)) result.push({ ...origin, eventKey, kind: "worker-question", questionId: question.id });
    }
    const uncertainEffect = worker.state === "reconciling" && !worker.assignment.readOnly &&
      attempt.effectIntentId && state.readEffectIntent(attempt.effectIntentId)?.status === "unknown";
    if (!["completed", "blocked", "failed", "cancelled"].includes(worker.state) && !uncertainEffect) continue;
    // Successful native completion precedes checkout reconciliation and Verification.
    if (worker.state === "completed" && !worker.assignment.readOnly) {
      const verification = operations.find((operation) =>
        operation.causedByWorker?.workerSessionId === worker.id &&
        operation.causedByWorker.executionAttemptId === executionAttemptId &&
        operation.causedByWorker.generation === attempt.generation,
      );
      if (!verification?.result) continue;
    }
    const eventKey = `terminal:${worker.id}:${executionAttemptId}`;
    if (!claimed.has(eventKey)) result.push({ ...origin, eventKey, kind: "worker-terminal" });
  }
  return result;
}

/** An interrupted inference may have dispatched effects: never replay its observation. */
export function reconcileLeadContinuations(state: AuthoritativeState): LeadContinuation[] {
  const failed: LeadContinuation[] = [];
  for (const receipt of state.readLeadContinuations()) {
    if (receipt.status !== "started") continue;
    if (state.leadAgentResponse(receipt.id) !== undefined) {
      state.settleLeadContinuation(receipt.id, "completed");
    } else {
      state.settleLeadContinuation(receipt.id, "failed", "continuity-lost");
      failed.push(state.readLeadContinuation(receipt.id)!);
    }
  }
  return failed;
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
