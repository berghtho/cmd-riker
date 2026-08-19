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
  evidence: Array<{
    reference: string;
    summary: string;
    observedAt: string | null;
    bearing: "supports" | "conflicts";
  }>;
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
    | "reserved-owner-decision"
    | "pause-incomplete"
    | "uncertain-effect"
    | "cancellation-incomplete"
    | "relevant-failure"
    | "capability-unavailable";
  subject: SessionViewSubject;
  scope: SessionViewScope;
  knownFacts: string[];
  unknowns: string[];
  recoveryConditions: string[];
  healthAssessment?: HealthAssessment;
  actions: SessionViewAction[];
};

export type SessionViewWorker = {
  id: string;
  subject: SessionViewSubject;
  scope: SessionViewScope;
  state: WorkerSession["state"];
  actions: SessionViewAction[];
};

export type SessionViewSnapshot = {
  leadAvailability: "available" | "responding";
  activeWorkerCount: number;
  workers: SessionViewWorker[];
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
  const unsettledWorkerByCommitment = new Map<string, WorkerSession>();
  for (const worker of workers) {
    if (worker.assignment.commitmentId && !isTerminalWorker(worker)) {
      unsettledWorkerByCommitment.set(worker.assignment.commitmentId, worker);
    }
  }
  const unknownEffects = state.readEffectIntents().filter((effect) => effect.status === "unknown");
  const unknownEffectsByCommitment = new Map<string, EffectIntent[]>();
  for (const effect of unknownEffects) {
    const scoped = unknownEffectsByCommitment.get(effect.commitmentId) ?? [];
    scoped.push(effect);
    unknownEffectsByCommitment.set(effect.commitmentId, scoped);
  }
  const cancellingCommitments = new Set(
    workers
      .filter((worker) => worker.state === "cancellation-requested")
      .flatMap((worker) => worker.assignment.commitmentId ? [worker.assignment.commitmentId] : []),
  );
  const visibleWorkers = workers
    .filter((worker) => !isTerminalWorker(worker))
    .map((worker) => ({
      id: worker.id,
      subject: workerSubject(worker),
      scope: workerScope(worker),
      state: worker.state,
      actions: workerInterventionActions(
        state,
        worker,
        attempts.get(worker.currentExecutionAttemptId),
        `worker:${worker.id}`,
        cancellationAvailable,
      ),
    }));
  const recoveryOwnedWorkerIds = new Set(
    visibleWorkers.flatMap((worker) => {
      const assignment = workerById.get(worker.id)?.assignment;
      return assignment?.coordination?.role === "recovery"
        ? [assignment.coordination.recoveryOfWorkerSessionId]
        : [];
    }),
  );
  const exceptions: SessionViewException[] = [];
  const pausedCommitments = new Set<string>();

  for (const commitment of commitments.values()) {
    if (commitment.condition?.kind !== "paused" || isTerminalCommitment(commitment)) continue;
    pausedCommitments.add(commitment.id);
    const worker = unsettledWorkerByCommitment.get(commitment.id);
    const workerUnsettled = Boolean(worker && !isTerminalWorker(worker));
    const scopedUnknownEffects = unknownEffectsByCommitment.get(commitment.id) ?? [];
    const effectUnsettled = scopedUnknownEffects.length > 0;
    if (!workerUnsettled && !effectUnsettled) continue;
    const attempt = worker ? attempts.get(worker.currentExecutionAttemptId) : undefined;
    const exceptionId = `pause:${commitment.id}`;
    exceptions.push({
      id: exceptionId,
      kind: "pause-incomplete",
      subject: commitmentSubject(commitment),
      scope: commitmentScope(commitment.id),
      knownFacts: ["The Owner pause is durably recorded for this Commitment."],
      unknowns: [
        ...(workerUnsettled ? ["Whether the linked Worker has ceased is not established."] : []),
        ...(effectUnsettled ? ["Whether at least one expected effect was applied."] : []),
      ],
      recoveryConditions: [
        "Resume or cancel through the Owner conversation; reconcile any uncertain effect before replay.",
        ...scopedUnknownEffects.map((effect) => effect.retryRule),
      ],
      actions: worker
        ? workerInterventionActions(state, worker, attempt, exceptionId, cancellationAvailable)
        : [],
    });
  }

  for (const question of state.readWorkerQuestions()) {
    if (
      question.ownerAttention?.kind !== "owner-reserved-decision" ||
      (question.status !== "open" && question.status !== "answer-recorded")
    ) {
      continue;
    }
    const worker = workerById.get(question.workerSessionId);
    if (!worker || isTerminalWorker(worker)) continue;
    const commitmentId = worker.assignment.commitmentId;
    if (commitmentId && pausedCommitments.has(commitmentId)) continue;
    const exceptionId = `worker-question:${question.id}`;
    exceptions.push({
      id: exceptionId,
      kind: "reserved-owner-decision",
      subject: workerSubject(worker),
      scope: workerScope(worker),
      knownFacts: [question.status === "answer-recorded"
        ? "An Owner answer is durably recorded for a reserved Worker question."
        : "A Worker question is explicitly classified as an Owner-reserved decision."],
      unknowns: [question.status === "answer-recorded"
        ? "Delivery to the current Worker execution is not yet established."
        : "The Owner decision has not yet been recorded."],
      recoveryConditions: [question.status === "answer-recorded"
        ? "Deliver the recorded answer to the current Worker execution."
        : question.ownerAttention.reason],
      actions: workerInterventionActions(
        state,
        worker,
        attempts.get(worker.currentExecutionAttemptId),
        exceptionId,
        cancellationAvailable,
      ),
    });
  }

  for (const commitment of commitments.values()) {
    if (isTerminalCommitment(commitment) || pausedCommitments.has(commitment.id)) continue;
    if (commitment.state === "awaiting-acceptance" && !commitment.condition?.ownerAttention) {
      const exceptionId = `owner-decision:${commitment.id}`;
      exceptions.push({
        id: exceptionId,
        kind: "reserved-owner-decision",
        subject: commitmentSubject(commitment),
        scope: commitmentScope(commitment.id),
        knownFacts: ["Objective work is complete and this Commitment reserves Acceptance to the Owner."],
        unknowns: ["The Owner Acceptance verdict is not recorded."],
        recoveryConditions: ["Accept, cancel, or supersede through the Owner conversation."],
        actions: [],
      });
      continue;
    }
    if (commitment.condition?.kind !== "blocked" || !commitment.condition.ownerAttention) continue;
    const exceptionId = `commitment-blocked:${commitment.id}`;
    exceptions.push({
      id: exceptionId,
      kind: "relevant-failure",
      subject: commitmentSubject(commitment),
      scope: commitmentScope(commitment.id),
      knownFacts: [commitment.condition.reason],
      unknowns: ["Freshness of the reported blocker is unknown."],
      recoveryConditions: [commitment.condition.nextAction],
      ...(includeHealth
        ? {
            healthAssessment: createHealthAssessment({
              subject: commitmentSubject(commitment),
              scope: commitmentScope(commitment.id),
              evidence: [{
                reference: `commitment:${commitment.id}`,
                summary: "Authoritative Commitment condition is blocked.",
                observedAt: null,
                bearing: "supports",
              }],
              assessedAt,
              verdict: "impaired",
            }),
          }
        : {}),
      actions: [],
    });
  }

  for (const effect of unknownEffects) {
    if (pausedCommitments.has(effect.commitmentId) || cancellingCommitments.has(effect.commitmentId)) {
      continue;
    }
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
            healthAssessment: createHealthAssessment({
              subject: effectSubject(effect.id),
              scope: commitmentScope(effect.commitmentId),
              evidence: [{
                reference: `effect-intent:${effect.id}`,
                summary: "Authoritative effect status is unknown.",
                observedAt: effect.lease?.claimedAt ?? null,
                bearing: "supports",
              }],
              assessedAt,
              verdict: "unknown",
            }),
          }
        : {}),
      actions: worker
        ? workerInterventionActions(
            state,
            worker,
            attempts.get(worker.currentExecutionAttemptId),
            exceptionId,
            cancellationAvailable,
          )
        : [],
    });
  }

  const materialCommitmentIds = new Set(
    [...commitments.values()]
      .filter((commitment) => Boolean(commitment.condition?.ownerAttention))
      .map((commitment) => commitment.id),
  );
  for (const worker of workers) {
    if (worker.state === "cancellation-requested") {
      const scopedUnknownEffects = worker.assignment.commitmentId
        ? unknownEffectsByCommitment.get(worker.assignment.commitmentId) ?? []
        : [];
      exceptions.push({
        id: `cancellation:${worker.id}`,
        kind: "cancellation-incomplete",
        subject: workerSubject(worker),
        scope: workerScope(worker),
        knownFacts: ["Cancellation intent is durably recorded."],
        unknowns: [
          "Native interruption acknowledgement and observed cessation are not yet established.",
          "Existing effects are not rolled back by cancellation.",
          ...(scopedUnknownEffects.length > 0
            ? ["Whether one or more expected effects were applied."]
            : []),
        ],
        recoveryConditions: [
          "Observe the Worker process stop, then reconcile any effect that may have occurred.",
          ...scopedUnknownEffects.map((effect) => effect.retryRule),
        ],
        ...(includeHealth
          ? {
              healthAssessment: createHealthAssessment({
                subject: workerSubject(worker),
                scope: workerScope(worker),
                evidence: [{
                  reference: `worker-session:${worker.id}`,
                  summary: "Cancellation intent is recorded; cessation is unsettled.",
                  observedAt: worker.cancellation?.requestedAt ?? null,
                  bearing: "supports",
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
    const linkedCommitment = worker.assignment.commitmentId
      ? commitments.get(worker.assignment.commitmentId)
      : undefined;
    if (
      !worker.ownerAttention ||
      recoveryOwnedWorkerIds.has(worker.id) ||
      (worker.assignment.commitmentId && materialCommitmentIds.has(worker.assignment.commitmentId)) ||
      (linkedCommitment && isTerminalCommitment(linkedCommitment))
    ) {
      continue;
    }
    exceptions.push({
      id: `worker-recovery:${worker.id}`,
      kind: "relevant-failure",
      subject: workerSubject(worker),
      scope: workerScope(worker),
      knownFacts: [worker.ownerAttention.reason],
      unknowns: ["Whether a changed recovery hypothesis will restore the Assignment is unknown."],
      recoveryConditions: [worker.ownerAttention.nextAction],
      ...(includeHealth
        ? {
            healthAssessment: createHealthAssessment({
              subject: workerSubject(worker),
              scope: workerScope(worker),
              evidence: [{
                reference: `worker-session:${worker.id}`,
                summary: worker.ownerAttention.reason,
                observedAt: null,
                bearing: "supports",
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
            healthAssessment: createHealthAssessment({
              subject: capabilitySubject(capability.id),
              scope: targetProjectScope(),
              evidence: [{
                reference: `capability-notice:${capability.id}`,
                summary: "Capability probe recorded an unavailable result.",
                observedAt: capability.observedAt,
                bearing: "supports",
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
    activeWorkerCount: visibleWorkers.length,
    workers: visibleWorkers,
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
    `Lead ${snapshot.leadAvailability} | ${snapshot.activeWorkerCount} ${workerLabel} | ${attention}` +
      (snapshot.activeWorkerCount > 0 ? " | /session workers" : ""),
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

export function renderSessionWorkers(
  snapshot: SessionViewSnapshot,
  selectedWorkerId?: string,
): string {
  if (snapshot.workers.length === 0) return "No active Worker Sessions.";
  const lines = snapshot.workers.map(
    (worker) =>
      `Worker ${worker.id} | ${worker.state} | ${worker.scope.label} | ` +
      `/session inspect worker:${worker.id}`,
  );
  const selected = snapshot.workers.find((worker) => worker.id === selectedWorkerId);
  if (!selected) return lines.join("\n");
  lines.push(
    `Selected Worker: ${selected.id}`,
    `  State: ${selected.state}`,
    `  Scope: ${selected.scope.label}`,
  );
  if (selected.actions.length > 0) {
    lines.push(`  Controls: ${selected.actions.map((action) => action.command).join(" | ")}`);
  }
  return lines.join("\n");
}

export function parseSessionViewWorkerInspection(
  snapshot: SessionViewSnapshot,
  input: string,
): SessionViewWorker | undefined {
  const target = inspectionTarget(input);
  return target?.startsWith("worker:")
    ? snapshot.workers.find((worker) => worker.id === target.slice("worker:".length))
    : undefined;
}

export function parseSessionViewInspection(
  snapshot: SessionViewSnapshot,
  input: string,
): SessionViewException | undefined {
  const target = inspectionTarget(input);
  return target ? snapshot.exceptions.find((item) => item.id === target) : undefined;
}

export function parseSessionViewControl(
  snapshot: SessionViewSnapshot,
  input: string,
): SessionViewAction | undefined {
  const match = /^\/session\s+(pause|cancel)\s+(\S+)\s*$/i.exec(input);
  if (!match) return undefined;
  const kind = match[1]!.toLowerCase() as SessionViewAction["kind"];
  const target = match[2]!;
  return snapshot.exceptions.find((exception) => exception.id === target)?.actions
    .find((action) => action.kind === kind) ??
    snapshot.workers.find((worker) => `worker:${worker.id}` === target)?.actions
      .find((action) => action.kind === kind);
}

function inspectionTarget(input: string): string | undefined {
  return /^\/session\s+inspect\s+(\S+)\s*$/i.exec(input)?.[1];
}

function workerInterventionActions(
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
  if (commitment?.state === "active" && !commitment.condition) {
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

export function createHealthAssessment(
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
  const hasConflictingEvidence = input.evidence.some((item) => item.bearing === "conflicts");
  const { assessedAt, verdict, ...assessmentFields } = input;
  return {
    ...assessmentFields,
    freshness: {
      assessedAt,
      newestEvidenceObservedAt,
      expiresAt,
      status: freshness,
    },
    verdict: freshness === "current" && !hasConflictingEvidence ? verdict : "unknown",
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
