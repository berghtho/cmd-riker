import { openAuthoritativeState, type AuthoritativeState } from "./authoritative-state/index.ts";
import type { HealthAssessment } from "./recovery-actor/index.ts";

type CheckVerdict = "passed" | "failed";

export type HostHealthAssessment = HealthAssessment & {
  checks: {
    exactIdentity: CheckVerdict;
    artifactIntegrity: CheckVerdict;
    authoritativeState: CheckVerdict;
    writeGeneration: CheckVerdict;
    conversationContext: CheckVerdict;
    writeReadProbe: CheckVerdict;
    recoveryHandshake: CheckVerdict;
    activationBarrier: CheckVerdict;
  };
};

export type HostHealthInput = {
  stateDirectory: string;
  expectedWriteGeneration: number;
  expectedAttemptId: string;
  reportedAttemptId: string;
  expectedCandidateRevision: string;
  reportedCandidateRevision: string;
  expectedArtifactDigest: string;
  observedArtifactDigest: string;
  expectedHandshakeNonce: string;
  reportedHandshakeNonce: string;
  observedAt: string;
};

export function assessHostHealth(input: HostHealthInput): HostHealthAssessment {
  const checks: HostHealthAssessment["checks"] = {
    exactIdentity: input.expectedAttemptId === input.reportedAttemptId &&
      input.expectedCandidateRevision === input.reportedCandidateRevision
      ? "passed"
      : "failed",
    artifactIntegrity: input.expectedArtifactDigest === input.observedArtifactDigest
      ? "passed"
      : "failed",
    authoritativeState: "failed",
    writeGeneration: "failed",
    conversationContext: "failed",
    writeReadProbe: "failed",
    recoveryHandshake: input.expectedHandshakeNonce === input.reportedHandshakeNonce
      ? "passed"
      : "failed",
    activationBarrier: "failed",
  };
  const evidence: string[] = [];
  let state: AuthoritativeState | undefined;
  try {
    if (checks.exactIdentity === "failed") throw new Error("Activation Attempt or candidate identity does not match.");
    if (checks.artifactIntegrity === "failed") throw new Error("Candidate artifact digest does not match.");
    if (checks.recoveryHandshake === "failed") throw new Error("Recovery Actor handshake does not match.");
    state = openAuthoritativeState(input.stateDirectory, {
      writeGeneration: input.expectedWriteGeneration,
    });
    checks.writeGeneration = "passed";
    const lifecycle = state.lifecycleStatus();
    checks.authoritativeState = lifecycle.integrity === "passed" && lifecycle.journalMode === "wal"
      ? "passed"
      : "failed";
    const conversation = state.readOwnerConversation();
    if (!conversation) throw new Error("Canonical Owner conversation cannot be reconstructed.");
    checks.conversationContext = "passed";
    state.probeLifecycle(`${input.expectedAttemptId}:${input.expectedHandshakeNonce}`);
    checks.writeReadProbe = "passed";
    const barrier = assessActivationBarrier(state);
    checks.activationBarrier = barrier.ready ? "passed" : "failed";
    evidence.push(...barrier.blockers);
    if (Object.values(checks).every((check) => check === "passed")) {
      evidence.push("All fixed activation invariants passed with fresh attempt-bound evidence.");
      return assessment("healthy", checks, evidence, input.observedAt);
    }
    return assessment("impaired", checks, evidence, input.observedAt);
  } catch (error) {
    evidence.push(error instanceof Error ? error.message : String(error));
    return assessment("unknown", checks, evidence, input.observedAt);
  } finally {
    state?.close();
  }
}

export function assessActivationBarrier(state: AuthoritativeState): {
  ready: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];
  const conversation = state.readOwnerConversation();
  for (const ownerMessage of conversation?.messages.filter((message) => message.role === "owner") ?? []) {
    if (state.ownerInteractionDisposition(ownerMessage.turnId) === "session-view-control") continue;
    if (state.leadAgentResponse(ownerMessage.turnId) === undefined) {
      blockers.push(`Activation is blocked by unanswered Owner turn ${ownerMessage.turnId}.`);
    }
  }
  for (const attempt of state.readLeadTurnAttempts()) {
    if (attempt.status === "started") blockers.push(`Lead turn attempt ${attempt.id} is started.`);
  }
  for (const commitment of state.readCommitments()) {
    if (commitment.state === "active" && !commitment.condition) {
      blockers.push(`Commitment ${commitment.id} is active without a safe condition.`);
    }
  }
  for (const worker of state.readWorkerSessions()) {
    if (!["completed", "blocked", "failed", "cancelled"].includes(worker.state)) {
      blockers.push(`Worker Session ${worker.id} is ${worker.state}.`);
    }
  }
  for (const question of state.readWorkerQuestions()) {
    if (question.status === "open") blockers.push(`Worker question ${question.id} is open.`);
  }
  for (const effect of state.readEffectIntents()) {
    if (["pending", "dispatching", "unknown"].includes(effect.status)) {
      blockers.push(`Effect intent ${effect.id} is ${effect.status}.`);
    } else if (
      effect.kind === "worker-assignment" &&
      effect.status === "succeeded" &&
      !effect.verificationOperationAttemptId
    ) {
      blockers.push(`Worker effect ${effect.id} is awaiting attributed Verification.`);
    }
  }
  for (const operation of state.readTargetProjectOperationAttempts()) {
    if (["ready", "running"].includes(operation.status)) {
      blockers.push(`Operation Attempt ${operation.id} is ${operation.status}.`);
    }
  }
  return { ready: blockers.length === 0, blockers };
}

function assessment(
  verdict: HealthAssessment["verdict"],
  checks: HostHealthAssessment["checks"],
  evidence: string[],
  observedAt: string,
): HostHealthAssessment {
  return {
    verdict,
    subject: "Lead Agent candidate",
    scope: "activation invariants",
    observedAt,
    evidence,
    checks,
  };
}
