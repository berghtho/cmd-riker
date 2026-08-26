import type {
  CapabilityNotice,
  Commitment,
  StandingOrder,
  WorkerExecutionAttempt,
  WorkerQuestion,
  WorkerSession,
} from "../orchestration-core/index.ts";
import type { EffectIntent } from "../target-project-operations/index.ts";
import type { ForgeOwnerActionNotice } from "../forge-operations/index.ts";
import type { LeadTurnMetrics } from "../model-selection.ts";
import type { OwnerSessionView } from "../authoritative-state/index.ts";

export type SessionViewWorker = {
  number: number;
  workerSessionId: string;
  label: string;
  status: WorkerSession["state"];
  cancellable: boolean;
  workItemId?: string;
  startedAt?: string;
};

export type SessionViewItem = {
  number: number;
  workItemId: string;
  outcome: string;
  status: string;
  needsOwner: boolean;
  detail?: string;
  since?: string;
};

export type SessionViewSnapshot = {
  leadAvailability: "available" | "responding";
  activeWorkerCount: number;
  workers: SessionViewWorker[];
  items: SessionViewItem[];
  /** Plain-language problems that deserve the Owner's eye. No identifiers. */
  notices: string[];
  /** What the last completed Lead turn ran on; configured selection before the first turn. */
  lead?: LeadTurnMetrics;
  /** Every recorded Standing Order, current ones first; expiry is derived, never stored. */
  standingOrders?: StandingOrderViewEntry[];
  /** Owner Sessions, most recently active first; `current` marks the one the Lead is serving. */
  sessions?: OwnerSessionViewEntry[];
  /** Configured projects, the default Target Project first. */
  projects?: OwnerProjectViewEntry[];
};

export type OwnerSessionViewEntry = {
  number: number;
  sessionId: string;
  name: string;
  current: boolean;
  lastActiveAt: string;
  state: "active" | "archived";
  /** The configured project this session works in; shown once several projects exist. */
  project?: string;
};

export type OwnerProjectViewEntry = {
  number: number;
  name: string;
  path: string;
  sessionCount: number;
};

export type StandingOrderViewEntry = {
  number: number;
  standingOrderId: string;
  title: string;
  /** "expired" is derived from validUntil; the journal keeps such orders "active". */
  status: "active" | "expired" | "revoked";
  instruction: string;
  effectClasses: string[];
  targets: string[];
  allowIrreversibleEffects: boolean;
  allowExternallyBindingEffects: boolean;
  maximumIncrementalSpendUsd: number;
  validUntil: string;
  revocationReason?: string;
};

export interface SessionViewState {
  readWorkerSessions(): WorkerSession[];
  readWorkerExecutionAttempt(attemptId: string): WorkerExecutionAttempt | undefined;
  readWorkerQuestions(): WorkerQuestion[];
  readEffectIntents(): EffectIntent[];
  readCommitments(): Commitment[];
  readCommitment(commitmentId: string): Commitment | undefined;
  readCapabilityNotice(
    id: CapabilityNotice["id"],
    targetProjectPath?: string,
  ): CapabilityNotice | undefined;
  readForgeOwnerActionNotices(): ForgeOwnerActionNotice[];
  commitmentRecordedAt?(commitmentId: string): string | undefined;
  readLatestLeadTurnMetrics?(sessionId?: string): LeadTurnMetrics | undefined;
  readStandingOrders?(): StandingOrder[];
  readOwnerSessions?(): OwnerSessionView[];
  readConfiguredProjects?(): Array<{ name: string; path: string }>;
  ownerSessionIdForTurn?(ownerTurnId: string): string | undefined;
}

export function projectSessionView(
  state: SessionViewState,
  options: {
    leadAvailability?: SessionViewSnapshot["leadAvailability"];
    cancellationAvailable?: boolean;
    activeSessionId?: string;
    targetProjectPath?: string;
  } = {},
): SessionViewSnapshot {
  const cancellationAvailable = options.cancellationAvailable ?? true;
  const configuredProjects = state.readConfiguredProjects?.() ?? [];
  const defaultProjectPath = configuredProjects[0]?.path;
  const ownerSessions = state.readOwnerSessions?.() ?? [];
  const sessionById = new Map(ownerSessions.map((session) => [session.id, session]));
  const projectPathOfSession = (sessionId: string | undefined): string | undefined =>
    sessionById.get(sessionId ?? "")?.projectPath ?? defaultProjectPath;
  const inProject = (path: string | undefined): boolean =>
    !options.targetProjectPath || (path !== undefined && samePath(path, options.targetProjectPath));
  const workers = state.readWorkerSessions().filter((worker) =>
    inProject(worker.assignment.targetProjectPath)
  );
  const commitmentProject = new Map<string, string>();
  for (const worker of state.readWorkerSessions()) {
    if (worker.assignment.commitmentId) {
      commitmentProject.set(worker.assignment.commitmentId, worker.assignment.targetProjectPath);
    }
  }
  const commitments = state.readCommitments().filter((commitment) => {
    const workerProject = commitmentProject.get(commitment.id);
    const ownerSessionId = state.ownerSessionIdForTurn?.(commitment.createdByOwnerTurnId);
    return inProject(workerProject ?? projectPathOfSession(ownerSessionId));
  });
  const unsettledWorkerByCommitment = new Map<string, WorkerSession>();
  for (const worker of workers) {
    if (worker.assignment.commitmentId && !isTerminalWorker(worker)) {
      unsettledWorkerByCommitment.set(worker.assignment.commitmentId, worker);
    }
  }
  const visibleWorkers = workers
    .filter((worker) => !isTerminalWorker(worker))
    .map((worker, index) => {
      const startedAt = state
        .readWorkerExecutionAttempt(worker.currentExecutionAttemptId)
        ?.process?.startedAt;
      return {
        number: index + 1,
        workerSessionId: worker.id,
        label: worker.assignment.objective,
        status: worker.state,
        cancellable: cancellationAvailable && worker.state !== "cancellation-requested",
        ...(worker.assignment.commitmentId
          ? { workItemId: worker.assignment.commitmentId }
          : {}),
        ...(startedAt ? { startedAt } : {}),
      };
    });
  const items = commitments
    .filter((commitment) => !["cancelled", "superseded"].includes(commitment.state))
    .map((commitment, index) => {
      const since = state.commitmentRecordedAt?.(commitment.id);
      return {
        ...sessionViewItem(index + 1, commitment, unsettledWorkerByCommitment.get(commitment.id)),
        ...(since ? { since } : {}),
      };
    });

  const notices: string[] = [];
  for (const effect of state.readEffectIntents()) {
    if (
      options.targetProjectPath &&
      !inProject(effect.authorization.targetProjectPath ?? commitmentProject.get(effect.commitmentId))
    ) continue;
    if (effect.status !== "unknown") continue;
    notices.push(
      "One effect could not be confirmed as applied or not applied; it needs reconciliation before a retry.",
    );
    break;
  }
  for (const worker of workers) {
    if (worker.ownerAttention?.kind === "recovery-exhausted") {
      notices.push(
        `A Worker (${worker.assignment.objective}) exhausted automatic recovery: ${worker.ownerAttention.reason}`,
      );
    }
  }
  const capability = state.readCapabilityNotice("codex-worker", options.targetProjectPath);
  if (capability?.state === "active") {
    notices.push(`The Codex Worker capability is unavailable: ${capability.detail}`);
  }
  for (const notice of state.readForgeOwnerActionNotices()) {
    if (notice.state !== "active") continue;
    notices.push(`${notice.provider}: ${notice.detail} Next: ${notice.nextAction}`);
  }

  const lead = state.readLatestLeadTurnMetrics?.(options.activeSessionId);
  const projectNameByPath = new Map(
    configuredProjects.map((project) => [project.path.toLowerCase(), project.name]),
  );
  const defaultProjectName = configuredProjects[0]?.name;
  const projectOf = (projectPath: string | undefined): string | undefined => {
    if (!projectPath) return configuredProjects.length > 1 ? defaultProjectName : undefined;
    return projectNameByPath.get(projectPath.toLowerCase()) ?? projectPath;
  };
  const projectSessions = ownerSessions.filter((session) =>
    inProject(session.projectPath ?? defaultProjectPath)
  );
  const sessions = (state.readOwnerSessions ? projectSessions : undefined)?.map((session, index) => {
    const project = projectOf(session.projectPath);
    return {
      number: index + 1,
      sessionId: session.id,
      name: session.name,
      current: session.id === options.activeSessionId,
      lastActiveAt: session.lastActiveAt,
      state: session.state,
      ...(project ? { project } : {}),
    };
  });
  const visibleProjects = options.targetProjectPath
    ? configuredProjects.filter((project) => samePath(project.path, options.targetProjectPath!))
    : configuredProjects;
  const projects =
    visibleProjects.length > 0
      ? visibleProjects.map((project, index) => ({
          number: index + 1,
          name: project.name,
          path: project.path,
          sessionCount: (sessions ?? []).filter(
            (session) => (session.project ?? defaultProjectName) === project.name,
          ).length,
        }))
      : undefined;
  const standingOrders = state.readStandingOrders
    ? projectStandingOrders(state.readStandingOrders())
    : undefined;
  // Authority that lapsed on its own deserves the same visibility as a failure:
  // a mission must not discover an expired Standing Order by being refused.
  for (const order of standingOrders ?? []) {
    if (order.status !== "expired") continue;
    notices.push(`Standing Order "${order.title}" has expired; its authority no longer applies.`);
  }
  return {
    leadAvailability: options.leadAvailability ?? "available",
    activeWorkerCount: visibleWorkers.length,
    workers: visibleWorkers,
    items,
    notices,
    ...(lead ? { lead } : {}),
    ...(standingOrders ? { standingOrders } : {}),
    ...(sessions ? { sessions } : {}),
    ...(projects ? { projects } : {}),
  };
}

function samePath(left: string, right: string): boolean {
  return left.replaceAll("/", "\\").toLowerCase() ===
    right.replaceAll("/", "\\").toLowerCase();
}

export function renderOwnerProjects(entries: OwnerProjectViewEntry[]): string {
  if (entries.length === 0) return "No projects configured.";
  return entries
    .map(
      (entry) =>
        `${entry.number}. ${entry.name} | ${entry.path} | ` +
        `${entry.sessionCount} session${entry.sessionCount === 1 ? "" : "s"} | ` +
        `/session new ${entry.name}`,
    )
    .join("\n");
}

export function renderOwnerSessions(entries: OwnerSessionViewEntry[]): string {
  if (entries.length === 0) return "No sessions yet. Start one with /session new.";
  return entries
    .map(
      (entry) =>
        `${entry.number}. ${entry.current ? "* " : ""}` +
        (entry.project ? `[${entry.project}] ` : "") +
        (entry.name || "(unnamed)") +
        (entry.state === "archived" ? " | archived" : "") +
        (entry.current ? "" : ` | /session use ${entry.number}`),
    )
    .join("\n");
}

export function parseOwnerSessionControl(
  entries: OwnerSessionViewEntry[],
  input: string,
):
  | { kind: "list-sessions" }
  | { kind: "list-projects" }
  | { kind: "new-session"; project?: string }
  | { kind: "use-session"; sessionId: string; name: string }
  | undefined {
  if (/^\/session\s+list\s*$/i.test(input)) return { kind: "list-sessions" };
  if (/^\/session\s+projects\s*$/i.test(input)) return { kind: "list-projects" };
  const create = /^\/session\s+new(?:\s+(\S+))?\s*$/i.exec(input);
  if (create) {
    return { kind: "new-session", ...(create[1] ? { project: create[1] } : {}) };
  }
  const use = /^\/session\s+use\s+(\d+)\s*$/i.exec(input);
  if (!use) return undefined;
  const entry = entries.find(
    (candidate) => candidate.number === Number(use[1]) && candidate.state === "active",
  );
  return entry
    ? { kind: "use-session", sessionId: entry.sessionId, name: entry.name }
    : undefined;
}

export function projectStandingOrders(
  orders: StandingOrder[],
  now = Date.now(),
): StandingOrderViewEntry[] {
  const status = (order: StandingOrder): StandingOrderViewEntry["status"] =>
    order.state === "revoked"
      ? "revoked"
      : Date.parse(order.validUntil) > now
        ? "active"
        : "expired";
  const rank: Record<StandingOrderViewEntry["status"], number> = {
    active: 0,
    expired: 1,
    revoked: 2,
  };
  return orders
    .map((order) => ({ order, status: status(order) }))
    .sort((left, right) => rank[left.status] - rank[right.status])
    .map(({ order, status: orderStatus }, index) => ({
      number: index + 1,
      standingOrderId: order.id,
      title: order.title,
      status: orderStatus,
      instruction: order.instruction,
      effectClasses: [...order.effectClasses],
      targets: [...order.targets],
      allowIrreversibleEffects: order.allowIrreversibleEffects,
      allowExternallyBindingEffects: order.allowExternallyBindingEffects,
      maximumIncrementalSpendUsd: order.maximumIncrementalSpendUsd,
      validUntil: order.validUntil,
      ...(order.revocation ? { revocationReason: order.revocation.reason } : {}),
    }));
}

export function renderStandingOrders(entries: StandingOrderViewEntry[]): string {
  if (entries.length === 0) return "No Standing Orders.";
  return entries
    .map((entry) => {
      const validity =
        entry.status === "active"
          ? `until ${entry.validUntil}`
          : entry.status === "expired"
            ? `EXPIRED ${entry.validUntil}`
            : `revoked: ${entry.revocationReason ?? "no reason recorded"}`;
      return (
        `${entry.number}. ${entry.status} | ${entry.title} | ${validity}` +
        (entry.status === "active" ? ` | /session order ${entry.number}` : "")
      );
    })
    .join("\n");
}

export function renderStandingOrderDetail(entry: StandingOrderViewEntry): string {
  const bounds = [
    entry.allowIrreversibleEffects ? "irreversible effects allowed" : "reversible effects only",
    entry.allowExternallyBindingEffects
      ? "externally binding effects allowed"
      : "no externally binding effects",
    `spend up to ${entry.maximumIncrementalSpendUsd} USD`,
  ].join("; ");
  return [
    `${entry.title} (${entry.status})`,
    `Instruction: ${entry.instruction}`,
    `Effects: ${entry.effectClasses.join(", ")}`,
    `Targets: ${entry.targets.join(", ")}`,
    `Bounds: ${bounds}`,
    entry.status === "revoked"
      ? `Revoked: ${entry.revocationReason ?? "no reason recorded"}`
      : `Valid until: ${entry.validUntil}${entry.status === "expired" ? " (EXPIRED)" : ""}`,
    ...(entry.status === "active"
      ? [`Revoke with /session revoke-order ${entry.number} <reason>`]
      : []),
  ].join("\n");
}

export function parseStandingOrderControl(
  entries: StandingOrderViewEntry[],
  input: string,
):
  | { kind: "show-order"; entry: StandingOrderViewEntry }
  | { kind: "revoke-order"; standingOrderId: string; reason: string }
  | undefined {
  const show = /^\/session\s+order\s+(\d+)\s*$/i.exec(input);
  if (show) {
    const entry = entries.find((candidate) => candidate.number === Number(show[1]));
    return entry ? { kind: "show-order", entry } : undefined;
  }
  const revoke = /^\/session\s+revoke-order\s+(\d+)\s+(\S.*)$/i.exec(input);
  if (!revoke) return undefined;
  const entry = entries.find(
    (candidate) => candidate.number === Number(revoke[1]) && candidate.status === "active",
  );
  return entry
    ? { kind: "revoke-order", standingOrderId: entry.standingOrderId, reason: revoke[2]!.trim() }
    : undefined;
}

/**
 * One compact status segment for the Lead's Model, reasoning budget, and
 * context occupancy, e.g. "gpt-5-codex xhigh · 42k/272k (15%)". Context is
 * omitted until a completed turn has produced measured usage.
 */
export function renderLeadTurnMetrics(metrics: LeadTurnMetrics): string {
  const model = metrics.thinkingLevel
    ? `${metrics.model} ${metrics.thinkingLevel}`
    : metrics.model;
  if (!metrics.contextWindow || metrics.contextTokens <= 0) return model;
  const thousands = (tokens: number): string => `${Math.round(tokens / 1000)}k`;
  const percent = Math.min(
    100,
    Math.round((metrics.contextTokens / metrics.contextWindow) * 100),
  );
  return (
    `${model} · ${thousands(metrics.contextTokens)}/${thousands(metrics.contextWindow)}` +
    ` (${percent}%)`
  );
}

function sessionViewItem(
  number: number,
  commitment: Commitment,
  worker: WorkerSession | undefined,
): SessionViewItem {
  const base = { number, workItemId: commitment.id, outcome: commitment.outcome };
  if (commitment.state === "accepted") return { ...base, status: "done", needsOwner: false };
  if (commitment.state === "awaiting-acceptance") {
    return { ...base, status: "done", needsOwner: false };
  }
  if (commitment.state === "verifying") {
    return { ...base, status: "verifying the result", needsOwner: false };
  }
  const condition = commitment.condition;
  if (condition) {
    if (condition.kind === "paused") {
      return { ...base, status: "paused", needsOwner: false, detail: condition.reason };
    }
    const needsOwner = Boolean(condition.ownerAttention);
    return {
      ...base,
      status: needsOwner
        ? "needs you"
        : condition.kind === "reconciling"
          ? "recovering"
          : "blocked",
      needsOwner,
      detail: `${condition.reason} Next: ${condition.nextAction}`,
    };
  }
  if (worker) {
    return { ...base, status: "in progress (Worker running)", needsOwner: false };
  }
  return { ...base, status: "in progress", needsOwner: false };
}

function itemsSummary(items: SessionViewItem[]): string {
  if (items.length === 0) return "no items";
  const needsOwner = items.filter((item) => item.needsOwner).length;
  const label = items.length === 1 ? "item" : "items";
  return needsOwner > 0
    ? `${items.length} ${label} (${needsOwner} need${needsOwner === 1 ? "s" : ""} you)`
    : `${items.length} ${label}`;
}

export function renderSessionItems(snapshot: SessionViewSnapshot): string {
  if (snapshot.items.length === 0) return "No work items.";
  return snapshot.items
    .map(
      (item) =>
        `${item.number}. ${item.status} | ${item.outcome}` +
        (item.detail ? `\n   ${item.detail}` : ""),
    )
    .join("\n");
}

export function renderSessionView(snapshot: SessionViewSnapshot): string {
  const workerLabel = snapshot.activeWorkerCount === 1 ? "Worker" : "Workers";
  const lines = [
    `Lead ${snapshot.leadAvailability} | ${snapshot.activeWorkerCount} ${workerLabel} | ` +
      itemsSummary(snapshot.items) +
      (snapshot.notices.length > 0 ? ` | ${snapshot.notices.length} notice(s)` : " | all quiet") +
      (snapshot.items.length > 0 ? " | /session items" : "") +
      (snapshot.activeWorkerCount > 0 ? " | /session workers" : ""),
  ];
  for (const notice of snapshot.notices) lines.push(`! ${notice}`);
  return lines.join("\n");
}

export function renderSessionWorkers(snapshot: SessionViewSnapshot): string {
  if (snapshot.workers.length === 0) return "No active Workers.";
  return snapshot.workers
    .map(
      (worker) =>
        `${worker.number}. ${worker.status} | ${worker.label}` +
        (worker.cancellable ? ` | /session cancel ${worker.number}` : ""),
    )
    .join("\n");
}

export function parseSessionViewControl(
  snapshot: SessionViewSnapshot,
  input: string,
): { kind: "cancel"; workerSessionId: string } | undefined {
  const match = /^\/session\s+cancel\s+(\d+)\s*$/i.exec(input);
  if (!match) return undefined;
  const worker = snapshot.workers.find(
    (candidate) => candidate.number === Number(match[1]) && candidate.cancellable,
  );
  return worker ? { kind: "cancel", workerSessionId: worker.workerSessionId } : undefined;
}

function isTerminalWorker(worker: WorkerSession): boolean {
  return ["completed", "blocked", "failed", "cancelled"].includes(worker.state);
}
