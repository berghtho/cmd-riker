import { resolve } from "node:path";

import type { AuthoritativeState } from "../authoritative-state/index.ts";
import type {
  Commitment,
  StandingOrder,
  WorkerQuestion,
  WorkerSession,
} from "../orchestration-core/index.ts";

/** Project ownership survives switching Owner Sessions and resuming a Work Item. */
export function createLeadProjectScope(state: AuthoritativeState, targetProjectPath: string) {
  const defaultProjectPath = state.readConfiguredProjects()[0]?.path;
  const containsPath = (path: string | undefined): boolean =>
    path !== undefined && pathKey(path) === pathKey(targetProjectPath);
  if (!state.readConfiguredProjects().some((project) => containsPath(project.path))) {
    throw new Error("The Owner Session must belong to a configured Target Project.");
  }
  const pathForOwnerTurn = (turnId: string): string | undefined => {
    const sessionId = state.ownerSessionIdForTurn(turnId);
    if (!sessionId) return undefined;
    return state.readOwnerSessions().find((session) => session.id === sessionId)?.projectPath ??
      defaultProjectPath;
  };
  const containsCommitment = (commitment: Commitment): boolean => {
    const originPath = pathForOwnerTurn(commitment.createdByOwnerTurnId);
    if (originPath) return containsPath(originPath);
    // Older imported work may have Worker ownership but no recorded Owner turn.
    const workers = state.readWorkerSessions().filter(
      (worker) => worker.assignment.commitmentId === commitment.id,
    );
    return workers.length > 0
      ? workers.every((worker) => containsPath(worker.assignment.targetProjectPath))
      : containsPath(defaultProjectPath);
  };
  const containsCommitmentId = (id: string): boolean => {
    const commitment = state.readCommitment(id);
    return !!commitment && containsCommitment(commitment);
  };
  const containsWorker = (worker: WorkerSession): boolean =>
    containsPath(worker.assignment.targetProjectPath) &&
    (!worker.assignment.commitmentId || containsCommitmentId(worker.assignment.commitmentId));
  const containsQuestion = (question: WorkerQuestion): boolean => {
    const worker = state.readWorkerSession(question.workerSessionId);
    return !!worker && containsWorker(worker);
  };
  const containsStandingOrder = (order: StandingOrder): boolean =>
    containsPath(pathForOwnerTurn(order.createdByOwnerTurnId) ?? defaultProjectPath) &&
    order.commitmentIds.every(containsCommitmentId);
  const requireScoped = <T>(value: T | undefined, contains: (value: T) => boolean, kind: string): T => {
    if (!value || !contains(value)) {
      throw new Error(`${kind} is unknown or outside the active Target Project.`);
    }
    return value;
  };
  return {
    containsCommitment,
    containsCommitmentId,
    containsWorker,
    containsQuestion,
    containsStandingOrder,
    commitments: () => state.readCommitments().filter(containsCommitment),
    requireCommitment: (id: string) =>
      requireScoped(state.readCommitment(id), containsCommitment, "Work Item"),
    requireWorker: (id: string) =>
      requireScoped(state.readWorkerSession(id), containsWorker, "Worker Session"),
    requireQuestion: (id: string) =>
      requireScoped(state.readWorkerQuestion(id), containsQuestion, "Worker question"),
    requireStandingOrder: (id: string) =>
      requireScoped(state.readStandingOrder(id), containsStandingOrder, "Standing Order"),
  };
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
