import type { PiOwnerResponse } from "./pi-owner-interface.ts";

export const ownerInputPrefix = "CMD_RIKER_OWNER_INPUT:";
export const ownerResponsePrefix = "CMD_RIKER_OWNER_RESPONSE:";
export const ownerConversationPrefix = "CMD_RIKER_OWNER_CONVERSATION:";
export const ownerTurnCompleteMarker = "CMD_RIKER_OWNER_TURN_COMPLETE";

export type HostedOwnerConversationEntry = {
  source: "owner" | "lead-agent";
  content: string;
};

export function encodeHostedOwnerInput(content: string): string {
  return `${ownerInputPrefix}${JSON.stringify({ content })}`;
}

export function decodeHostedOwnerInput(line: string): string | undefined {
  if (!line.startsWith(ownerInputPrefix)) return undefined;
  try {
    const value = JSON.parse(line.slice(ownerInputPrefix.length)) as { content?: unknown };
    return typeof value.content === "string" ? value.content : undefined;
  } catch {
    return undefined;
  }
}

export function encodeHostedOwnerResponse(response: PiOwnerResponse): string {
  return `${ownerResponsePrefix}${JSON.stringify(response)}`;
}

export function decodeHostedOwnerResponse(line: string): PiOwnerResponse | undefined {
  if (!line.startsWith(ownerResponsePrefix)) return undefined;
  try {
    const value = JSON.parse(line.slice(ownerResponsePrefix.length)) as {
      source?: unknown;
      content?: unknown;
    };
    return (value.source === "Lead Agent" || value.source === "Session View") &&
        typeof value.content === "string"
      ? { source: value.source, content: value.content }
      : undefined;
  } catch {
    return undefined;
  }
}

export function encodeHostedOwnerConversation(
  conversation: readonly HostedOwnerConversationEntry[],
): string {
  return `${ownerConversationPrefix}${JSON.stringify(conversation)}`;
}

export function decodeHostedOwnerConversation(
  line: string,
): HostedOwnerConversationEntry[] | undefined {
  if (!line.startsWith(ownerConversationPrefix)) return undefined;
  try {
    const value = JSON.parse(line.slice(ownerConversationPrefix.length)) as unknown;
    if (!Array.isArray(value)) return undefined;
    const conversation: HostedOwnerConversationEntry[] = [];
    for (const entry of value) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("source" in entry) ||
        (entry.source !== "owner" && entry.source !== "lead-agent") ||
        !("content" in entry) ||
        typeof entry.content !== "string"
      ) return undefined;
      conversation.push({ source: entry.source, content: entry.content });
    }
    return conversation;
  } catch {
    return undefined;
  }
}
