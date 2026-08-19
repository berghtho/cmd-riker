import type {
  CapabilityNotice,
  Commitment,
  WorkerExecutionAttempt,
  WorkerQuestion,
  WorkerSession,
} from "../orchestration-core/index.ts";
import type { EffectIntent } from "../target-project-operations/index.ts";

const healthEvidenceFreshnessMs = 60_000;

export type SessionViewSubject = {
  kind: "worker-session" | "effect-intent" | "worker-capability" | "commitment";
  id: string;
  label: string;
};

export type SessionViewScope = {
  kind: "assignment" | "commitment" | "target-project";
  id: string;
  label: string;
};

export type HealthAssessment = {
  subject: SessionViewSubject;
  scope: SessionViewScope;
  evidence: Array<{ reference: string; summary: string; observedAt: string | null }>;
  freshness: {
    assessedAt: string;
    newestEvidenceObservedAt: string | null;
    expiresAt: string | null;
    status: "current" | "stale" | "unknown";
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
    | "pause-incomplete"
    | "uncertain-effect"
    | "cancellation-incomplete"
    | "worker-impaired"
    | "capability-unavailable";
  subject: SessionViewSubject;
  scope: SessionViewScope;
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
  readCommitments(): Commitment[];
  readCommitment(commitmentId: string): Commitment | undefined;
  readCapabilityNotice(id: CapabilityNotice["id"]): CapabilityNotice | undefined;
}

export function projectSessionView(
  state: SessionViewState,
  options: {
    leadAvailability?: SessionViewSnapshot["leadAvailability"];
    assessedAt?: string;
    cancellationAvailable?: boolean;
    includeHealthAssessments?: boolean;
  } = {},
): SessionViewSnapshot {
  const assessedAt = options.assessedAt ?? new Date().toISOString();
  const includeHealth = options.includeHealthAssessments ?? true;
  const cancellationAvailable = options.cancellationAvailable ?? true;
  const workers = state.readWorkerSessions();
  const attempts = new Map(
    workers.map((worker) => [
      worker.currentExecutionAttemptId,
      state.readWorkerExecutionAttempt(worker.currentExecutionAttemptId),
    ]),
  );
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));
  const commitments = new Map(state.readCommitments().map((item) => [item.id, item]));
  const latestWorkerByCommitment = new Map<string, WorkerSession>();
  for (const worker of workers) {
    if (worker.assignment.commitmentId) {
      latestWorkerByCommitment.set(worker.assignment.commitmentId, worker);
    }
  }
  const exceptions: SessionViewException[] = [];
  const pausedCommitments = new Set<string>();

  for (const commitment of commitments.values()) {
    if (commitment.condition?.kind !== "paused" || isTerminalCommitment(commitment)) continue;
    pausedCommitments.add(commitment.id);
    const worker = latestWorkerByCommitment.get(commitment.id);
    const attempt = worker ? attempts.get(worker.currentExecutionAttemptId) : undefined;
    const exceptionId = `pause:${commitment.id}`;
    exceptions.push({
      id: exceptionId,
      kind: "pause-incomplete",
      subject: commitmentSubject(commitment),
      scope: commitmentScope(commitment.id),
      knownFacts: ["The Owner pause is durably recorded for this Commitment."],
      unknowns: worker && !isTerminalWorker(worker)
        ? ["The linked Worker and any existing effects remain separate, unsettled facts."]
        : [],
      recoveryConditions: [
        "Resume or cancel through the Owner conversation; reconcile any uncertain effect before replay.",
      ],
      actions: worker
        ? interventionActions(state, worker, attempt, exceptionId, cancellationAvailable)
        : [],
    });
  }

  for (const question of state.readWorkerQuestions()) {
    if (question.status !== "open" && question.status !== "answer-recorded") continue;
    const worker = workerById.get(question.workerSessionId);
    const commitment = worker?.assignment.commitmentId
      ? commitments.get(worker.assignment.commitmentId)
      : undefined;
    if (
      !worker ||
      worker.state !== "waiting-question" ||
      !commitment ||
      pausedCommitments.has(commitment.id) ||
      !commitment.criteria.some((criterion) => criterion.kind === "owner-judgment")
    ) {
      continue;
    }
    const exceptionId = `worker-question:${question.id}`;
    exceptions.push({
      id: exceptionId,
      kind: "owner-question",
      subject: workerSubject(worker),
      scope: commitmentScope(commitment.id),
      knownFacts: [
        question.status === "answer-recorded"
          ? "An Owner answer is durably recorded for a reserved native Worker question."
          : "A reserved Owner decision is waiting in a native Worker question.",
      ],
      unknowns: [
        question.status === "answer-recorded"
          ? "Delivery to the current Worker execution is not yet established."
          : "The Owner decision has not yet been bound to the Worker question.",
      ],
      recoveryConditions: [
        question.status === "answer-recorded"
          ? "Deliver the recorded answer to the current Worker execution."
          : "Answer the reserved decision through the Owner conversation.",
      ],
      actions: interventionActions(
        state,
        worker,
        attempts.get(worker.currentExecutionAttemptId),
        exceptionId,
        cancellationAvailable,
      ),
    });
  }

  for (const effect of state.readEffectIntents()) {
    if (effect.status !== "unknown") continue;
    const worker = effect.kind === "worker-assignment"
      ? workerById.get(effect.workerSessionId)
      : undefined;
    const exceptionId = `uncertain-effect:${effect.id}`;
    exceptions.push({
      id: exceptionId,
      kind: "uncertain-effect",
      subject: effectSubject(effect.id),
      scope: commitmentScope(effect.commitmentId),
      knownFacts: ["A bounded effect was dispatched and its durable status is unknown."],
      unknowns: ["Whether the expected effect was applied."],
      recoveryConditions: [effect.retryRule],
      ...(includeHealth
        ? {
            healthAssessment: assessment({
              subject: effectSubject(effect.id),
              scope: commitmentScope(effect.commitmentId),
              evidence: [{
                reference: `effect-intent:${effect.id}`,
                summary: "Authoritative effect status is unknown.",
                observedAt: effect.lease?.claimedAt ?? null,
              }],
              assessedAt,
              verdict: "unknown",
            }),
          }
        : {}),
      actions: worker
        ? interventionActions(
            state,
            worker,
            attempts.get(worker.currentExecutionAttemptId),
            exceptionId,
            cancellationAvailable,
          )
        : [],
    });
  }

  for (const worker of workers) {
    if (worker.state === "cancellation-requested") {
      exceptions.push({
        id: `cancellation:${worker.id}`,
        kind: "cancellation-incomplete",
        subject: workerSubject(worker),
        scope: workerScope(worker),
        knownFacts: ["Cancellation intent is durably recorded."],
        unknowns: [
          "Native interruption acknowledgement and observed cessation are not yet established.",
          "Existing effects are not rolled back by cancellation.",
        ],
        recoveryConditions: [
          "Observe the Worker process stop, then reconcile any effect that may have occurred.",
        ],
        ...(includeHealth
          ? {
              healthAssessment: assessment({
                subject: workerSubject(worker),
                scope: workerScope(worker),
                evidence: [{
                  reference: `worker-session:${worker.id}`,
                  summary: "Cancellation intent is recorded; cessation is unsettled.",
                  observedAt: worker.cancellation?.requestedAt ?? null,
                }],
                assessedAt,
                verdict: "unknown",
              }),
            }
          : {}),
        actions: [],
      });
      continue;
    }
    const commitmentId = worker.assignment.commitmentId;
    const commitment = commitmentId ? commitments.get(commitmentId) : undefined;
    if (
      (worker.state !== "failed" && worker.state !== "blocked") ||
      !commitment ||
      commitment.condition?.kind !== "blocked" ||
      isTerminalCommitment(commitment) ||
      latestWorkerByCommitment.get(commitment.id)?.id !== worker.id
    ) {
      continue;
    }
    exceptions.push({
      id: `worker-impaired:${worker.id}`,
      kind: "worker-impaired",
      subject: workerSubject(worker),
      scope: commitmentScope(commitment.id),
      knownFacts: [
        `The authoritative Worker state is ${worker.state} and its Commitment is blocked.`,
      ],
      unknowns: ["No fresh, timestamped failure evidence is available in this projection."],
      recoveryConditions: [commitment.condition.nextAction],
      ...(includeHealth
        ? {
            healthAssessment: assessment({
              subject: workerSubject(worker),
              scope: commitmentScope(commitment.id),
              evidence: [{
                reference: `worker-session:${worker.id}`,
                summary: `Authoritative Worker state is ${worker.state}.`,
                observedAt: null,
              }],
              assessedAt,
              verdict: "impaired",
            }),
          }
        : {}),
      actions: [],
    });
  }

  const capability = state.readCapabilityNotice("codex-worker");
  if (capability?.state === "active") {
    exceptions.push({
      id: `capability:${capability.id}`,
      kind: "capability-unavailable",
      subject: capabilitySubject(capability.id),
      scope: targetProjectScope(),
      knownFacts: ["The last configured Codex Worker capability probe was unavailable."],
      unknowns: ["Whether a correctly authenticated native Codex session is usable now."],
      recoveryConditions: ["Prove the expected native identity and capability available again."],
      ...(includeHealth
        ? {
            healthAssessment: assessment({
              subject: capabilitySubject(capability.id),
              scope: targetProjectScope(),
              evidence: [{
                reference: `capability-notice:${capability.id}`,
                summary: "Capability probe recorded an unavailable result.",
                observedAt: capability.observedAt,
              }],
              assessedAt,
              verdict: "unavailable",
            }),
          }
        : {}),
      actions: [],
    });
  }

  return {
    leadAvailability: options.leadAvailability ?? "available",
    activeWorkerCount: workers.filter((worker) => !isTerminalWorker(worker)).length,
    exceptions,
  };
}

export function renderSessionView(
  snapshot: SessionViewSnapshot,
  selectedExceptionId?: string,
): string {
  const workerLabel = snapshot.activeWorkerCount === 1 ? "Worker Session" : "Worker Sessions";
  const attention = snapshot.exceptions.length === 0
    ? "no attention"
    : attentionClasses(snapshot.exceptions);
  const lines = [
    `Lead ${snapshot.leadAvailability} | ${snapshot.activeWorkerCount} ${workerLabel} | ${attention}`,
  ];
  if (snapshot.exceptions.length === 0) return lines.join("\n");
  for (const exception of snapshot.exceptions) {
    lines.push(
      `! ${exception.id} | ${exception.kind} | ${exception.subject.label} | ` +
        `/session inspect ${exception.id}`,
    );
  }
  if (!selectedExceptionId) return lines.join("\n");
  const selected = snapshot.exceptions.find((item) => item.id === selectedExceptionId);
  if (!selected) return lines.join("\n");
  lines.push(
    `Selected: ${selected.id}`,
    `  Subject: ${selected.subject.label}`,
    `  Scope: ${selected.scope.label}`,
    ...selected.knownFacts.map((fact) => `  Known: ${fact}`),
    ...selected.unknowns.map((unknown) => `  Unknown: ${unknown}`),
    ...selected.recoveryConditions.map((condition) => `  Recovery: ${condition}`),
  );
  if (selected.healthAssessment) {
    const health = selected.healthAssessment;
    lines.push(
      `  Health Assessment: subject=${health.subject.kind}:${health.subject.id}; ` +
        `scope=${health.scope.kind}:${health.scope.id}; verdict=${health.verdict}`,
      `  Evidence: ${health.evidence.map((item) => item.reference).join(", ")}`,
      `  Freshness: assessed=${health.freshness.assessedAt}; ` +
        `evidence=${health.freshness.newestEvidenceObservedAt ?? "unknown"}; ` +
        `expires=${health.freshness.expiresAt ?? "unknown"}; ` +
        `status=${health.freshness.status}`,
    );
  }
  if (selected.actions.length > 0) {
    lines.push(`  Controls: ${selected.actions.map((action) => action.command).join(" | ")}`);
  }
  return lines.join("\n");
}

export function parseSessionViewInspection(
  snapshot: SessionViewSnapshot,
  input: string,
): SessionViewException | undefined {
  const match = /^\/session\s+inspect\s+(\S+)\s*$/i.exec(input);
  return match ? snapshot.exceptions.find((item) => item.id === match[1]) : undefined;
}

export function parseSessionViewControl(
  snapshot: SessionViewSnapshot,
  input: string,
): SessionViewAction | undefined {
  const match = /^\/session\s+(pause|cancel)\s+(\S+)\s*$/i.exec(input);
  if (!match) return undefined;
  const kind = match[1]!.toLowerCase() as SessionViewAction["kind"];
  return snapshot.exceptions
    .find((exception) => exception.id === match[2])
    ?.actions.find((action) => action.kind === kind);
}

function interventionActions(
  state: SessionViewState,
  worker: WorkerSession,
  attempt: WorkerExecutionAttempt | undefined,
  exceptionId: string,
  cancellationAvailable: boolean,
): SessionViewAction[] {
  if (isTerminalWorker(worker) || worker.state === "cancellation-requested" || worker.state === "reconciling") {
    return [];
  }
  const actions: SessionViewAction[] = [];
  const commitmentId = worker.assignment.commitmentId;
  const commitment = commitmentId ? state.readCommitment(commitmentId) : undefined;
  if (worker.state === "waiting-question" && commitment?.state === "active" && !commitment.condition) {
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

function assessment(
  input: Omit<HealthAssessment, "freshness" | "verdict"> & {
    assessedAt: string;
    verdict: Exclude<HealthAssessment["verdict"], "healthy">;
  },
): HealthAssessment {
  const newestEvidenceObservedAt = input.evidence
    .map((item) => item.observedAt)
    .filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1) ?? null;
  const assessedTime = Date.parse(input.assessedAt);
  const evidenceTime = newestEvidenceObservedAt ? Date.parse(newestEvidenceObservedAt) : Number.NaN;
  const expiresAt = Number.isFinite(evidenceTime)
    ? new Date(evidenceTime + healthEvidenceFreshnessMs).toISOString()
    : null;
  const freshness: HealthAssessment["freshness"]["status"] = !Number.isFinite(evidenceTime)
    ? "unknown"
    : assessedTime <= evidenceTime + healthEvidenceFreshnessMs
      ? "current"
      : "stale";
  const { assessedAt, verdict, ...assessmentFields } = input;
  return {
    ...assessmentFields,
    freshness: {
      assessedAt,
      newestEvidenceObservedAt,
      expiresAt,
      status: freshness,
    },
    verdict: freshness === "current" ? verdict : "unknown",
  };
}

function attentionClasses(exceptions: SessionViewException[]): string {
  const counts = new Map<SessionViewException["kind"], number>();
  for (const exception of exceptions) counts.set(exception.kind, (counts.get(exception.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(", ");
}

function workerSubject(worker: WorkerSession): SessionViewSubject {
  return { kind: "worker-session", id: worker.id, label: `Worker Session ${worker.id}` };
}

function effectSubject(id: string): SessionViewSubject {
  return { kind: "effect-intent", id, label: `Effect intent ${id}` };
}

function capabilitySubject(id: string): SessionViewSubject {
  return { kind: "worker-capability", id, label: "Codex Worker capability" };
}

function commitmentSubject(commitment: Commitment): SessionViewSubject {
  return { kind: "commitment", id: commitment.id, label: `Commitment ${commitment.id}` };
}

function commitmentScope(id: string): SessionViewScope {
  return { kind: "commitment", id, label: `Commitment ${id}` };
}

function workerScope(worker: WorkerSession): SessionViewScope {
  return worker.assignment.commitmentId
    ? commitmentScope(worker.assignment.commitmentId)
    : { kind: "assignment", id: worker.id, label: `Assignment ${worker.id}` };
}

function targetProjectScope(): SessionViewScope {
  return { kind: "target-project", id: "configured-target-project", label: "Configured Target Project" };
}

function isTerminalWorker(worker: WorkerSession): boolean {
  return ["completed", "blocked", "failed", "cancelled"].includes(worker.state);
}

function isTerminalCommitment(commitment: Commitment): boolean {
  return ["accepted", "cancelled", "superseded"].includes(commitment.state);
}
