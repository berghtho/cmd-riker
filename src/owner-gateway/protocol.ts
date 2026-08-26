import { createInterface } from "node:readline";

import type {
  OwnerGatewayClient,
  OwnerGatewayEvent,
  OwnerGatewaySnapshot,
} from "./index.ts";
import type { PiOwnerResponse } from "../pi-owner-interface.ts";

export const ownerGatewayProtocolVersion = 1;

export type OwnerGatewayProtocolMessage =
  | {
      type: "ready";
      protocolVersion: typeof ownerGatewayProtocolVersion;
      childPid: number;
      snapshot: OwnerGatewaySnapshot;
    }
  | { type: "event"; event: OwnerGatewayEvent }
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
  let ready = false;
  const pendingEvents: OwnerGatewayEvent[] = [];
  const send = (message: OwnerGatewayProtocolMessage): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const unsubscribe = gateway.subscribe((event) => {
    if (ready) send({ type: "event", event });
    else pendingEvents.push(event);
  });
  send({
    type: "ready",
    protocolVersion: ownerGatewayProtocolVersion,
    childPid: gateway.childPid,
    snapshot: gateway.snapshot,
  });
  ready = true;
  for (const event of pendingEvents.splice(0)) send({ type: "event", event });

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
