import type { PiOwnerResponse } from "./pi-owner-interface.ts";

export const ownerInputPrefix = "CMD_RIKER_OWNER_INPUT:";
export const ownerResponsePrefix = "CMD_RIKER_OWNER_RESPONSE:";
export const ownerConversationPrefix = "CMD_RIKER_OWNER_CONVERSATION:";
export const ownerTurnCompleteMarker = "CMD_RIKER_OWNER_TURN_COMPLETE";

export type HostedOwnerConversationEntry = {
  source: "owner" | "lead-agent";
  content: string;
};

export type HostedOwnerConversation = {
  sessionId: string;
  targetProjectPath: string;
  entries: HostedOwnerConversationEntry[];
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
      reattach?: unknown;
    };
    return (value.source === "Lead Agent" || value.source === "Session View") &&
        typeof value.content === "string"
      ? {
          source: value.source,
          content: value.content,
          ...(value.reattach === true ? { reattach: true as const } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

export function encodeHostedOwnerConversation(
  conversation: HostedOwnerConversation,
): string {
  return `${ownerConversationPrefix}${JSON.stringify(conversation)}`;
}

export function decodeHostedOwnerConversation(
  line: string,
): HostedOwnerConversation | undefined {
  if (!line.startsWith(ownerConversationPrefix)) return undefined;
  try {
    const value = JSON.parse(line.slice(ownerConversationPrefix.length)) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("sessionId" in value) ||
      typeof value.sessionId !== "string" ||
      !("targetProjectPath" in value) ||
      typeof value.targetProjectPath !== "string" ||
      !("entries" in value) ||
      !Array.isArray(value.entries)
    ) return undefined;
    const entries: HostedOwnerConversationEntry[] = [];
    for (const entry of value.entries) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("source" in entry) ||
        (entry.source !== "owner" && entry.source !== "lead-agent") ||
        !("content" in entry) ||
        typeof entry.content !== "string"
      ) return undefined;
      entries.push({ source: entry.source, content: entry.content });
    }
    return {
      sessionId: value.sessionId,
      targetProjectPath: value.targetProjectPath,
      entries,
    };
  } catch {
    return undefined;
  }
}
