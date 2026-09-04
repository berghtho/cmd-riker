import type { PiOwnerResponse } from "./pi-owner-interface.ts";

export const ownerInputPrefix = "CMD_RIKER_OWNER_INPUT:";
export const ownerResponsePrefix = "CMD_RIKER_OWNER_RESPONSE:";
export const ownerErrorPrefix = "CMD_RIKER_OWNER_ERROR:";
export const ownerConversationPrefix = "CMD_RIKER_OWNER_CONVERSATION:";
export const ownerSessionViewPrefix = "CMD_RIKER_OWNER_SESSION_VIEW:";
export const ownerProjectsPrefix = "CMD_RIKER_OWNER_PROJECTS:";
export const ownerTurnCompleteMarker = "CMD_RIKER_OWNER_TURN_COMPLETE";
export const ownerInterruptPrefix = "CMD_RIKER_OWNER_INTERRUPT:";
export const leadStatePrefix = "CMD_RIKER_LEAD_STATE:";

export type OwnerInputScope = { targetProjectPath?: string; sessionId?: string; ownerTurnId?: string };

export function encodeHostedOwnerInterrupt(scope: OwnerInputScope = {}): string {
  return `${ownerInterruptPrefix}${JSON.stringify(scope)}`;
}

export function decodeHostedOwnerInterrupt(line: string): OwnerInputScope | undefined {
  if (!line.startsWith(ownerInterruptPrefix)) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(ownerInterruptPrefix.length));
    if (typeof value !== "object" || value === null) return undefined;
    const scope = value as Record<string, unknown>;
    if (
      (scope.targetProjectPath !== undefined && typeof scope.targetProjectPath !== "string") ||
      (scope.sessionId !== undefined && typeof scope.sessionId !== "string") ||
      (scope.ownerTurnId !== undefined && typeof scope.ownerTurnId !== "string") ||
      (scope.sessionId !== undefined && !scope.targetProjectPath)
    ) return undefined;
    return {
      ...(typeof scope.targetProjectPath === "string" ? { targetProjectPath: scope.targetProjectPath } : {}),
      ...(typeof scope.sessionId === "string" ? { sessionId: scope.sessionId } : {}),
      ...(typeof scope.ownerTurnId === "string" ? { ownerTurnId: scope.ownerTurnId } : {}),
    };
  } catch {
    return undefined;
  }
}

export type HostedOwnerInput = {
  content: string;
  targetProjectPath?: string;
  sessionId?: string;
};

export type HostedOwnerConversationEntry = {
  source: "owner" | "lead-agent";
  content: string;
};

export type HostedOwnerConversation = {
  sessionId?: string;
  targetProjectPath: string;
  entries: HostedOwnerConversationEntry[];
};

export type HostedOwnerSessionView<T> = {
  targetProjectPath: string;
  sessionId?: string;
  snapshot: T;
};

export function encodeHostedOwnerInput(
  content: string,
  scope: { targetProjectPath: string; sessionId?: string } | undefined = undefined,
): string {
  return `${ownerInputPrefix}${JSON.stringify({ content, ...scope })}`;
}

export function decodeHostedOwnerInput(line: string): HostedOwnerInput | undefined {
  if (!line.startsWith(ownerInputPrefix)) return undefined;
  try {
    const value = JSON.parse(line.slice(ownerInputPrefix.length)) as {
      content?: unknown;
      targetProjectPath?: unknown;
      sessionId?: unknown;
    };
    if (
      typeof value.content !== "string" ||
      (value.targetProjectPath !== undefined && typeof value.targetProjectPath !== "string") ||
      (value.sessionId !== undefined && typeof value.sessionId !== "string")
    ) return undefined;
    return {
      content: value.content,
      ...(value.targetProjectPath ? { targetProjectPath: value.targetProjectPath } : {}),
      ...(value.sessionId ? { sessionId: value.sessionId } : {}),
    };
  } catch {
    return undefined;
  }
}

export function encodeHostedOwnerError(message: string): string {
  return `${ownerErrorPrefix}${JSON.stringify({ message })}`;
}

export function decodeHostedOwnerError(line: string): string | undefined {
  if (!line.startsWith(ownerErrorPrefix)) return undefined;
  try {
    const value = JSON.parse(line.slice(ownerErrorPrefix.length)) as { message?: unknown };
    return typeof value.message === "string" ? value.message : undefined;
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
      ("sessionId" in value && value.sessionId !== undefined && typeof value.sessionId !== "string") ||
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
      ...("sessionId" in value && typeof value.sessionId === "string"
        ? { sessionId: value.sessionId }
        : {}),
      targetProjectPath: value.targetProjectPath,
      entries,
    };
  } catch {
    return undefined;
  }
}

export function encodeHostedOwnerSessionView<T>(view: HostedOwnerSessionView<T>): string {
  return `${ownerSessionViewPrefix}${JSON.stringify(view)}`;
}

export function decodeHostedOwnerSessionView<T>(
  line: string,
): HostedOwnerSessionView<T> | undefined {
  if (!line.startsWith(ownerSessionViewPrefix)) return undefined;
  try {
    const value = JSON.parse(line.slice(ownerSessionViewPrefix.length)) as {
      targetProjectPath?: unknown;
      sessionId?: unknown;
      snapshot?: unknown;
    };
    if (
      typeof value.targetProjectPath !== "string" ||
      (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
      typeof value.snapshot !== "object" ||
      value.snapshot === null
    ) return undefined;
    return {
      targetProjectPath: value.targetProjectPath,
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
      snapshot: value.snapshot as T,
    };
  } catch {
    return undefined;
  }
}

export type HostedOwnerProject = { targetProjectPath: string; sessionId?: string };

export function encodeHostedOwnerProjects(projects: readonly HostedOwnerProject[]): string {
  return `${ownerProjectsPrefix}${JSON.stringify({ projects })}`;
}

export function decodeHostedOwnerProjects(line: string): HostedOwnerProject[] | undefined {
  if (!line.startsWith(ownerProjectsPrefix)) return undefined;
  try {
    const value = JSON.parse(line.slice(ownerProjectsPrefix.length)) as { projects?: unknown };
    if (!Array.isArray(value.projects)) return undefined;
    const projects: HostedOwnerProject[] = [];
    for (const project of value.projects) {
      if (
        typeof project !== "object" ||
        project === null ||
        !("targetProjectPath" in project) ||
        typeof project.targetProjectPath !== "string" ||
        ("sessionId" in project && project.sessionId !== undefined &&
          typeof project.sessionId !== "string")
      ) return undefined;
      projects.push({
        targetProjectPath: project.targetProjectPath,
        ...(typeof project.sessionId === "string" ? { sessionId: project.sessionId } : {}),
      });
    }
    return projects;
  } catch {
    return undefined;
  }
}
