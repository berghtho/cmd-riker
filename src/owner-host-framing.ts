import type { PiOwnerResponse } from "./pi-owner-interface.ts";

export const ownerInputPrefix = "CMD_RIKER_OWNER_INPUT:";
export const ownerResponsePrefix = "CMD_RIKER_OWNER_RESPONSE:";

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
