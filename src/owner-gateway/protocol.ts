import { createInterface } from "node:readline";

import type {
  OwnerGatewayClient,
  OwnerGatewayConversationEntry,
  OwnerGatewayEvent,
  OwnerGatewaySnapshot,
} from "./index.ts";
import type { PiOwnerResponse } from "../pi-owner-interface.ts";
import type { LeadTurnMetrics } from "../model-selection.ts";
import type {
  OwnerProjectViewEntry,
  SessionViewItem,
  SessionViewSnapshot,
  SessionViewWorker,
  StandingOrderViewEntry,
} from "../session-view/index.ts";

export const ownerGatewayProtocolVersion = 2;

export type OwnerGatewayProtocolSessionView = {
  leadAvailability: SessionViewSnapshot["leadAvailability"];
  activeWorkerCount: number;
  workers: Array<Omit<SessionViewWorker, "workerSessionId" | "workItemId"> & {
    workItemNumber?: number;
  }>;
  items: Array<Omit<SessionViewItem, "workItemId">>;
  notices: string[];
  lead?: LeadTurnMetrics;
  standingOrders?: Array<Omit<StandingOrderViewEntry, "standingOrderId">>;
  sessions?: Array<{
    number: number;
    name: string;
    current: boolean;
    lastActiveAt: string;
    state: "active" | "archived";
    project?: string;
  }>;
  projects?: OwnerProjectViewEntry[];
};

export type OwnerGatewayProtocolSnapshot = {
  targetProjectPath: string;
  ownerSessionRevision: number;
  leadState: OwnerGatewaySnapshot["leadState"];
  conversation: OwnerGatewayConversationEntry[];
  sessionView?: OwnerGatewayProtocolSessionView;
};

export type OwnerGatewayProtocolEvent =
  | Extract<OwnerGatewayEvent, { type: "conversation" }>
  | { type: "session-view"; sessionView: OwnerGatewayProtocolSessionView }
  | { type: "lead-state"; state: "responding" | "available" }
  | { type: "notice"; content: string }
  | Extract<OwnerGatewayEvent, { type: "exit" }>;

export type OwnerGatewayProtocolMessage =
  | {
      type: "ready";
      protocolVersion: typeof ownerGatewayProtocolVersion;
      childPid: number;
      snapshot: OwnerGatewayProtocolSnapshot;
    }
  | { type: "event"; event: OwnerGatewayProtocolEvent }
  | { type: "turn-result"; id: string; response: PiOwnerResponse }
  | { type: "turn-error"; id: string; message: string }
  | { type: "protocol-error"; message: string };

type OwnerGatewayProtocolCommand = {
  type: "turn";
  id: string;
  content: string;
};

export async function runOwnerGatewayProtocol(
  gateway: OwnerGatewayClient,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  const send = (message: OwnerGatewayProtocolMessage): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const unsubscribe = gateway.subscribe((event) =>
    send({ type: "event", event: protocolEvent(event) })
  );
  send({
    type: "ready",
    protocolVersion: ownerGatewayProtocolVersion,
    childPid: gateway.childPid,
    snapshot: protocolSnapshot(gateway.snapshot),
  });

  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let command: OwnerGatewayProtocolCommand;
      try {
        command = decodeCommand(line);
      } catch (error) {
        send({
          type: "protocol-error",
          message: error instanceof Error ? error.message : "Invalid Owner Gateway command.",
        });
        continue;
      }
      try {
        const response = await gateway.completeTurn(command.content);
        send({ type: "turn-result", id: command.id, response });
      } catch (error) {
        send({
          type: "turn-error",
          id: command.id,
          message: error instanceof Error ? error.message : "The Owner turn failed.",
        });
      }
    }
  } finally {
    unsubscribe();
    await gateway.detach();
  }
}

function protocolSnapshot(snapshot: OwnerGatewaySnapshot): OwnerGatewayProtocolSnapshot {
  return {
    targetProjectPath: snapshot.targetProjectPath,
    ownerSessionRevision: snapshot.ownerSessionRevision,
    leadState: snapshot.leadState,
    conversation: snapshot.conversation,
    ...(snapshot.sessionView
      ? { sessionView: protocolSessionView(snapshot.sessionView) }
      : {}),
  };
}

function protocolEvent(event: OwnerGatewayEvent): OwnerGatewayProtocolEvent {
  return event.type === "session-view"
    ? { type: "session-view", sessionView: protocolSessionView(event.sessionView) }
    : event;
}

function protocolSessionView(snapshot: SessionViewSnapshot): OwnerGatewayProtocolSessionView {
  const itemNumberById = new Map(snapshot.items.map((item) => [item.workItemId, item.number]));
  return {
    leadAvailability: snapshot.leadAvailability,
    activeWorkerCount: snapshot.activeWorkerCount,
    workers: snapshot.workers.map((worker) => ({
      number: worker.number,
      label: worker.label,
      status: worker.status,
      cancellable: worker.cancellable,
      ...(worker.workItemId && itemNumberById.has(worker.workItemId)
        ? { workItemNumber: itemNumberById.get(worker.workItemId)! }
        : {}),
      ...(worker.startedAt ? { startedAt: worker.startedAt } : {}),
    })),
    items: snapshot.items.map((item) => ({
      number: item.number,
      outcome: item.outcome,
      status: item.status,
      needsOwner: item.needsOwner,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.since ? { since: item.since } : {}),
    })),
    notices: snapshot.notices,
    ...(snapshot.lead ? { lead: snapshot.lead } : {}),
    ...(snapshot.standingOrders
      ? {
          standingOrders: snapshot.standingOrders.map((order) => ({
            number: order.number,
            title: order.title,
            status: order.status,
            instruction: order.instruction,
            effectClasses: order.effectClasses,
            targets: order.targets,
            allowIrreversibleEffects: order.allowIrreversibleEffects,
            allowExternallyBindingEffects: order.allowExternallyBindingEffects,
            maximumIncrementalSpendUsd: order.maximumIncrementalSpendUsd,
            validUntil: order.validUntil,
            ...(order.revocationReason ? { revocationReason: order.revocationReason } : {}),
          })),
        }
      : {}),
    ...(snapshot.sessions
      ? {
          sessions: snapshot.sessions.map((session) => ({
            number: session.number,
            name: session.name,
            current: session.current,
            lastActiveAt: session.lastActiveAt,
            state: session.state,
            ...(session.project ? { project: session.project } : {}),
          })),
        }
      : {}),
    ...(snapshot.projects ? { projects: snapshot.projects } : {}),
  };
}

function decodeCommand(line: string): OwnerGatewayProtocolCommand {
  const value = JSON.parse(line) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    value.type !== "turn" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !("content" in value) ||
    typeof value.content !== "string" ||
    value.content.length === 0
  ) {
    throw new Error("Expected a turn command with non-empty string id and content.");
  }
  return { type: "turn", id: value.id, content: value.content };
}
