import type {
  CapabilityNotice,
  Commitment,
  WorkerExecutionAttempt,
  WorkerQuestion,
  WorkerSession,
} from "../orchestration-core/index.ts";
import type { EffectIntent } from "../target-project-operations/index.ts";

export type HealthAssessment = {
  subject: { kind: "worker-session" | "effect-intent" | "worker-capability"; id: string };
  scope: { kind: "assignment" | "commitment" | "target-project"; id: string };
  evidence: Array<{ reference: string; summary: string; observedAt: string | null }>;
  freshness: {
    assessedAt: string;
    newestEvidenceObservedAt: string | null;
    status: "timestamped" | "unknown";
    horizon: "until-authoritative-fact-changes";
  };
  verdict: "healthy" | "impaired" | "unavailable" | "unknown";
};

export type SessionViewAction = {
  kind: "pause" | "cancel";
  targetKind: "commitment" | "worker-session";
  targetId: string;
  command: string;
};

export type SessionViewException = {
  id: string;
  kind:
    | "owner-question"
    | "uncertain-effect"
    | "cancellation-incomplete"
    | "worker-impaired"
    | "capability-unavailable";
  subject: string;
  scope: string;
  knownFacts: string[];
  unknowns: string[];
  recoveryConditions: string[];
  healthAssessment?: HealthAssessment;
  actions: SessionViewAction[];
};

export type SessionViewSnapshot = {
  leadAvailability: "available" | "responding";
  activeWorkerCount: number;
  exceptions: SessionViewException[];
};

export interface SessionViewState {
  readWorkerSessions(): WorkerSession[];
  readWorkerExecutionAttempt(attemptId: string): WorkerExecutionAttempt | undefined;
  readWorkerQuestions(): WorkerQuestion[];
  readEffectIntents(): EffectIntent[];
  readCommitment(commitmentId: string): Commitment | undefined;
  readCapabilityNotice(id: CapabilityNotice["id"]): CapabilityNotice | undefined;
}

export function projectSessionView(
  state: SessionViewState,
  options: {
    leadAvailability?: SessionViewSnapshot["leadAvailability"];
    assessedAt?: string;
    cancellationAvailable?: boolean;
  } = {},
): SessionViewSnapshot {
  const assessedAt = options.assessedAt ?? new Date().toISOString();
  const workers = state.readWorkerSessions();
  const attempts = new Map(
    workers.map((worker) => [
      worker.currentExecutionAttemptId,
      state.readWorkerExecutionAttempt(worker.currentExecutionAttemptId),
    ]),
  );
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));
  const exceptions: SessionViewException[] = [];

  for (const question of state.readWorkerQuestions()) {
    if (question.status !== "open" && question.status !== "answer-recorded") continue;
    const worker = workerById.get(question.workerSessionId);
    if (!worker || worker.state !== "waiting-question") continue;
    const attempt = attempts.get(worker.currentExecutionAttemptId);
    const actions = interventionActions(
      state,
      worker,
      attempt,
      `worker-question:${question.id}`,
      options.cancellationAvailable ?? true,
    );
    exceptions.push({
      id: `worker-question:${question.id}`,
      kind: "owner-question",
      subject: `Worker Session ${worker.id}`,
      scope: assignmentScope(worker),
      knownFacts: [
        question.status === "answer-recorded"
          ? "An Owner answer is durably recorded for a native Worker question."
          : "A native Worker question is waiting for an Owner answer.",
      ],
      unknowns: [
        question.status === "answer-recorded"
          ? "Delivery of the recorded answer to the current Worker execution is not yet established."
          : "The Owner decision has not yet been bound to the Worker question.",
      ],
      recoveryConditions: [
        question.status === "answer-recorded"
          ? "Deliver the recorded answer to the current Worker execution."
          : "Answer the question through the Owner conversation.",
      ],
      actions,
    });
  }

  for (const effect of state.readEffectIntents()) {
    if (effect.status !== "unknown") continue;
    const worker = effect.kind === "worker-assignment" ? workerById.get(effect.workerSessionId) : undefined;
    const attempt = worker ? attempts.get(worker.currentExecutionAttemptId) : undefined;
    const observedAt = effect.lease?.claimedAt ?? null;
    const exceptionId = `uncertain-effect:${effect.id}`;
    exceptions.push({
      id: exceptionId,
      kind: "uncertain-effect",
      subject: `Effect intent ${effect.id}`,
      scope: `Commitment ${effect.commitmentId}`,
      knownFacts: ["A bounded effect was dispatched and its durable status is unknown."],
      unknowns: ["Whether the expected effect was applied."],
      recoveryConditions: [effect.retryRule],
      healthAssessment: assessment({
        subject: { kind: "effect-intent", id: effect.id },
        scope: { kind: "commitment", id: effect.commitmentId },
        evidence: [{
          reference: `effect-intent:${effect.id}`,
          summary: "Authoritative effect status is unknown.",
          observedAt,
        }],
        assessedAt,
        verdict: "unknown",
      }),
      actions: worker
        ? interventionActions(
            state,
            worker,
            attempt,
            exceptionId,
            options.cancellationAvailable ?? true,
          )
        : [],
    });
  }

  for (const worker of workers) {
    const attempt = attempts.get(worker.currentExecutionAttemptId);
    if (worker.state === "cancellation-requested") {
      const observedAt = worker.cancellation?.requestedAt ?? null;
      exceptions.push({
        id: `cancellation:${worker.id}`,
        kind: "cancellation-incomplete",
        subject: `Worker Session ${worker.id}`,
        scope: assignmentScope(worker),
        knownFacts: ["Cancellation intent is durably recorded."],
        unknowns: [
          "Native interruption acknowledgement and observed cessation are not yet established.",
          "Existing effects are not rolled back by cancellation.",
        ],
        recoveryConditions: [
          "Observe the Worker process stop, then reconcile any effect that may have occurred.",
        ],
        healthAssessment: assessment({
          subject: { kind: "worker-session", id: worker.id },
          scope: worker.assignment.commitmentId
            ? { kind: "commitment", id: worker.assignment.commitmentId }
            : { kind: "assignment", id: worker.id },
          evidence: [{
            reference: `worker-session:${worker.id}`,
            summary: "Cancellation intent is recorded; cessation is unsettled.",
            observedAt,
          }],
          assessedAt,
          verdict: "unknown",
        }),
        actions: [],
      });
      continue;
    }
    if (worker.state !== "failed" && worker.state !== "blocked") continue;
    const observedAt = attempt?.process?.startedAt ?? null;
    exceptions.push({
      id: `worker-impaired:${worker.id}`,
      kind: "worker-impaired",
      subject: `Worker Session ${worker.id}`,
      scope: assignmentScope(worker),
      knownFacts: [`The authoritative Worker state is ${worker.state}.`],
      unknowns: worker.outcome?.unresolvedUncertainty
        ? ["The Worker outcome retains unresolved uncertainty."]
        : [],
      recoveryConditions: ["The Lead Agent must diagnose or redelegate within the Assignment scope."],
      healthAssessment: assessment({
        subject: { kind: "worker-session", id: worker.id },
        scope: worker.assignment.commitmentId
          ? { kind: "commitment", id: worker.assignment.commitmentId }
          : { kind: "assignment", id: worker.id },
        evidence: [{
          reference: `worker-session:${worker.id}`,
          summary: `Authoritative Worker state is ${worker.state}.`,
          observedAt,
        }],
        assessedAt,
        verdict: "impaired",
      }),
      actions: [],
    });
  }

  const capability = state.readCapabilityNotice("codex-worker");
  if (capability?.state === "active") {
    exceptions.push({
      id: `capability:${capability.id}`,
      kind: "capability-unavailable",
      subject: "Codex Worker capability",
      scope: "Configured Target Project",
      knownFacts: ["The configured Codex Worker capability could not be proven available."],
      unknowns: ["Whether a correctly authenticated native Codex session is currently usable."],
      recoveryConditions: ["Prove the expected native identity and capability available again."],
      healthAssessment: assessment({
        subject: { kind: "worker-capability", id: capability.id },
        scope: { kind: "target-project", id: "configured-target-project" },
        evidence: [{
          reference: `capability-notice:${capability.id}`,
          summary: "Capability probe recorded an unavailable result.",
          observedAt: capability.observedAt,
        }],
        assessedAt,
        verdict: "unavailable",
      }),
      actions: [],
    });
  }

  return {
    leadAvailability: options.leadAvailability ?? "available",
    activeWorkerCount: workers.filter((worker) => !isTerminal(worker.state)).length,
    exceptions,
  };
}

export function renderSessionView(snapshot: SessionViewSnapshot): string {
  const workerLabel = snapshot.activeWorkerCount === 1 ? "Worker Session" : "Worker Sessions";
  const attention = snapshot.exceptions.length === 0
    ? "no attention"
    : `${snapshot.exceptions.length} need attention`;
  const lines = [
    `Lead ${snapshot.leadAvailability} | ${snapshot.activeWorkerCount} ${workerLabel} | ${attention}`,
  ];
  for (const exception of snapshot.exceptions) {
    lines.push(
      `! ${exception.id} | ${exception.kind}`,
      `  Subject: ${exception.subject}`,
      `  Scope: ${exception.scope}`,
      ...exception.knownFacts.map((fact) => `  Known: ${fact}`),
      ...exception.unknowns.map((unknown) => `  Unknown: ${unknown}`),
      ...exception.recoveryConditions.map((condition) => `  Recovery: ${condition}`),
    );
    if (exception.healthAssessment) {
      const health = exception.healthAssessment;
      lines.push(
        `  Health Assessment: subject=${health.subject.kind}:${health.subject.id}; ` +
          `scope=${health.scope.kind}:${health.scope.id}; verdict=${health.verdict}`,
        `  Evidence: ${health.evidence.map((item) => item.reference).join(", ")}`,
        `  Freshness: assessed=${health.freshness.assessedAt}; ` +
          `evidence=${health.freshness.newestEvidenceObservedAt ?? "unknown"}; ` +
          `status=${health.freshness.status}`,
      );
    }
    if (exception.actions.length > 0) {
      lines.push(`  Controls: ${exception.actions.map((action) => action.command).join(" | ")}`);
    }
  }
  return lines.join("\n");
}

export function parseSessionViewControl(
  snapshot: SessionViewSnapshot,
  input: string,
): SessionViewAction | undefined {
  const match = /^\/session\s+(pause|cancel)\s+(\S+)\s*$/i.exec(input);
  if (!match) return undefined;
  const kind = match[1]!.toLowerCase() as SessionViewAction["kind"];
  const exceptionId = match[2]!;
  return snapshot.exceptions
    .find((exception) => exception.id === exceptionId)
    ?.actions.find((action) => action.kind === kind);
}

function interventionActions(
  state: SessionViewState,
  worker: WorkerSession,
  attempt: WorkerExecutionAttempt | undefined,
  exceptionId: string,
  cancellationAvailable: boolean,
): SessionViewAction[] {
  if (isTerminal(worker.state) || worker.state === "cancellation-requested" || worker.state === "reconciling") {
    return [];
  }
  const actions: SessionViewAction[] = [];
  const commitmentId = worker.assignment.commitmentId;
  const commitment = commitmentId ? state.readCommitment(commitmentId) : undefined;
  if (
    worker.state === "waiting-question" &&
    commitment?.state === "active" &&
    !commitment.condition
  ) {
    actions.push({
      kind: "pause",
      targetKind: "commitment",
      targetId: commitment.id,
      command: `/session pause ${exceptionId}`,
    });
  }
  if (cancellationAvailable && attempt?.capabilities?.cancellation) {
    actions.push({
      kind: "cancel",
      targetKind: "worker-session",
      targetId: worker.id,
      command: `/session cancel ${exceptionId}`,
    });
  }
  return actions;
}

function assessment(input: Omit<HealthAssessment, "freshness"> & { assessedAt: string }): HealthAssessment {
  const newestEvidenceObservedAt = input.evidence
    .map((item) => item.observedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
  const { assessedAt, ...assessmentFields } = input;
  return {
    ...assessmentFields,
    freshness: {
      assessedAt,
      newestEvidenceObservedAt,
      status: newestEvidenceObservedAt ? "timestamped" : "unknown",
      horizon: "until-authoritative-fact-changes",
    },
  };
}

function assignmentScope(worker: WorkerSession): string {
  return worker.assignment.commitmentId
    ? `Commitment ${worker.assignment.commitmentId}`
    : `Assignment ${worker.id}`;
}

function isTerminal(state: WorkerSession["state"]): boolean {
  return ["completed", "blocked", "failed", "cancelled"].includes(state);
}
