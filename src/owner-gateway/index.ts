import type { PiOwnerResponse } from "../pi-owner-interface.ts";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  connectLocalLeadHost,
  type LeadHostExit,
  type LeadHostState,
  type LeadHostTranscriptEntry,
  type LocalLeadHostClient,
} from "../local-host/index.ts";
import type { SessionViewSnapshot } from "../session-view/index.ts";
import {
  decodeHostedOwnerConversation,
  decodeHostedOwnerProjects,
  decodeHostedOwnerSessionView,
  ownerTurnCompleteMarker,
  type HostedOwnerConversation,
  type HostedOwnerConversationEntry,
  type HostedOwnerProject,
  type HostedOwnerSessionView,
} from "../owner-host-framing.ts";

const sessionViewPrefix = "CMD_RIKER_SESSION_JSON:";
const workerNoticePrefix = "CMD_RIKER_WORKER_NOTICE: ";

export type OwnerGatewayConversationEntry = HostedOwnerConversationEntry;

export type OwnerGatewaySnapshot = {
  targetProjectPath: string;
  ownerSessionRevision: number;
  leadState: LeadHostState;
  conversation: OwnerGatewayConversationEntry[];
  sessionView?: SessionViewSnapshot;
};

export type OwnerGatewayEvent =
  | {
      type: "conversation";
      conversation: OwnerGatewayConversationEntry[];
      targetProjectPath: string;
      ownerSessionRevision: number;
      replaced: boolean;
    }
  | { type: "session-view"; sessionView: SessionViewSnapshot }
  | { type: "lead-state"; state: "responding" | "available" }
  | { type: "notice"; content: string }
  | { type: "exit"; exit: LeadHostExit };

export type OwnerGatewayClient = {
  readonly childPid: number;
  readonly snapshot: OwnerGatewaySnapshot;
  completeTurn(ownerInput: string): Promise<PiOwnerResponse>;
  subscribe(listener: (event: OwnerGatewayEvent) => void): () => void;
  detach(): Promise<void>;
};

export async function connectOwnerGateway(
  address: string,
  options: { projectPath?: string; connectTimeoutMs?: number; readyTimeoutMs?: number } = {},
): Promise<OwnerGatewayClient> {
  const requestedProject = options.projectPath
    ? projectIdentity(options.projectPath)
    : undefined;
  const client = await connectLocalHostWithRetry(address, options.connectTimeoutMs ?? 0);
  const initial = await waitForReadySnapshot(
    client,
    requestedProject,
    options.readyTimeoutMs ?? 60_000,
  ).catch(async (error: unknown) => {
    await client.detach();
    throw error;
  });
  const boundProjectPath = requestedProject?.canonicalPath;
  const configuredProjectPath = requestedProject ? initial.configuredProjectPath : undefined;
  const listeners = new Set<(event: OwnerGatewayEvent) => void>();
  let activeSessionId = initial.conversation.sessionId;
  let currentProjectPath = initial.conversation.targetProjectPath;
  let ownerSessionRevision = 1;
  let conversation = initial.conversation.entries;
  let sessionView = initial.sessionView
    ? privateSessionView(initial.sessionView.snapshot, activeSessionId, boundProjectPath)
    : undefined;

  const publish = (event: OwnerGatewayEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A presentation adapter must not disturb the hosted Lead Agent.
      }
    }
  };
  const publishConversation = (replaced: boolean): void => publish({
    type: "conversation",
    conversation,
    targetProjectPath: boundProjectPath ?? currentProjectPath,
    ownerSessionRevision,
    replaced,
  });

  const unsubscribeTranscript = client.onTranscriptEntry((entry) => {
    const conversationUpdate = conversationFrame(entry);
    if (conversationUpdate) {
      if (boundProjectPath) {
        if (
          !sameProjectPath(conversationUpdate.targetProjectPath, configuredProjectPath!) ||
          conversationUpdate.sessionId !== activeSessionId
        ) return;
      } else if (conversationUpdate.sessionId !== activeSessionId) {
        activeSessionId = conversationUpdate.sessionId;
        ownerSessionRevision += 1;
      }
      if (!boundProjectPath) currentProjectPath = conversationUpdate.targetProjectPath;
      conversation = conversationUpdate.entries;
      publishConversation(false);
      return;
    }
    const scopedView = sessionViewFrame(entry);
    if (scopedView) {
      if (
        boundProjectPath &&
        (!sameProjectPath(scopedView.targetProjectPath, configuredProjectPath!) ||
          scopedView.sessionId !== activeSessionId)
      ) return;
      sessionView = privateSessionView(scopedView.snapshot, activeSessionId, boundProjectPath);
      publish({ type: "session-view", sessionView: withLeadState(sessionView, client.leadState) });
      return;
    }
    for (const event of gatewayEvents(entry)) {
      if (boundProjectPath && (event.type === "session-view" || event.type === "notice")) continue;
      if (event.type === "session-view") sessionView = event.sessionView;
      publish(event.type === "session-view"
        ? { type: "session-view", sessionView: withLeadState(event.sessionView, client.leadState) }
        : event);
    }
  });
  const unsubscribeExit = client.onExit((exit) => publish({ type: "exit", exit }));

  return {
    childPid: client.childPid,
    get snapshot() {
      return {
        targetProjectPath: boundProjectPath ?? currentProjectPath,
        ownerSessionRevision,
        leadState: client.leadState,
        conversation,
        ...(sessionView ? { sessionView: withLeadState(sessionView, client.leadState) } : {}),
      };
    },
    async completeTurn(ownerInput) {
      if (!boundProjectPath) return client.completeOwnerTurn(ownerInput);
      const previousSessionId = activeSessionId;
      const result = await client.completeScopedOwnerTurn(ownerInput, {
        targetProjectPath: configuredProjectPath!,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      });
      if (ownerInput.trim().toLowerCase() === "/interrupt") return result.response;
      activeSessionId = result.sessionId;
      if (activeSessionId !== previousSessionId) ownerSessionRevision += 1;
      const latest = latestConversation(client.transcript, configuredProjectPath, activeSessionId);
      if (latest) conversation = latest.entries;
      const latestView = latestSessionView(
        client.transcript,
        configuredProjectPath!,
        activeSessionId,
        true,
      );
      if (latestView) {
        sessionView = privateSessionView(latestView.snapshot, activeSessionId, boundProjectPath);
        publish({ type: "session-view", sessionView: withLeadState(sessionView, client.leadState) });
      }
      if (activeSessionId !== previousSessionId) publishConversation(true);
      return result.response;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async detach() {
      unsubscribeExit();
      unsubscribeTranscript();
      listeners.clear();
      await client.detach();
    },
  };
}

async function connectLocalHostWithRetry(
  address: string,
  timeoutMs: number,
): Promise<LocalLeadHostClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      return await connectLocalLeadHost(address);
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  } while (true);
  throw new Error("Timed out waiting for the protected Lead Agent.", { cause: lastError });
}

function withLeadState(
  snapshot: SessionViewSnapshot,
  leadState: LeadHostState,
): SessionViewSnapshot {
  return leadState === "starting" ? snapshot : { ...snapshot, leadAvailability: leadState };
}

function privateSessionView(
  snapshot: SessionViewSnapshot,
  activeSessionId: string | undefined,
  publicProjectPath?: string,
): SessionViewSnapshot {
  return {
    ...snapshot,
    ...(snapshot.sessions
      ? {
          sessions: snapshot.sessions.map((session) => ({
            ...session,
            current: session.sessionId === activeSessionId,
          })),
        }
      : {}),
    ...(publicProjectPath && snapshot.projects
      ? {
          projects: snapshot.projects.map((project) => ({
            ...project,
            path: publicProjectPath,
          })),
        }
      : {}),
  };
}

function gatewayEvents(entry: LeadHostTranscriptEntry): OwnerGatewayEvent[] {
  if (entry.source === "owner") return [{ type: "lead-state", state: "responding" }];
  if (entry.stream !== "stdout") return [];
  if (entry.line === ownerTurnCompleteMarker) return [{ type: "lead-state", state: "available" }];
  if (entry.line.startsWith(workerNoticePrefix)) {
    return [{ type: "notice", content: entry.line.slice(workerNoticePrefix.length) }];
  }
  if (entry.line.startsWith(sessionViewPrefix)) {
    try {
      return [{
        type: "session-view",
        sessionView: JSON.parse(entry.line.slice(sessionViewPrefix.length)) as SessionViewSnapshot,
      }];
    } catch {
      return [];
    }
  }
  return [];
}

type ReadySnapshot = {
  conversation: HostedOwnerConversation;
  sessionView?: HostedOwnerSessionView<SessionViewSnapshot>;
  configuredProjectPath?: string;
};

type ProjectIdentity = { canonicalPath: string; comparisonKey: string };

function waitForReadySnapshot(
  client: LocalLeadHostClient,
  requestedProject: ProjectIdentity | undefined,
  timeoutMs: number,
): Promise<ReadySnapshot> {
  const inspect = (): ReadySnapshot | Error | undefined => {
    if (!requestedProject) {
      const conversation = latestConversation(client.transcript);
      const snapshot = latestLegacySessionView(client.transcript);
      if (conversation && snapshot) {
        return {
          conversation,
          sessionView: { targetProjectPath: conversation.targetProjectPath, snapshot },
        };
      }
      return undefined;
    }
    const projects = latestConfiguredProjects(client.transcript);
    let project: HostedOwnerProject | undefined;
    try {
      project = projects?.find((candidate) =>
        sameProjectIdentity(projectIdentity(candidate.targetProjectPath), requestedProject)
      );
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    if (projects && !project) {
      return new Error(`Unknown configured project path "${requestedProject.canonicalPath}".`);
    }
    if (!project) return undefined;
    const conversation = latestConversation(
      client.transcript,
      project.targetProjectPath,
      project.sessionId,
      true,
    );
    const sessionView = latestSessionView(
      client.transcript,
      project.targetProjectPath,
      project.sessionId,
      true,
    );
    return conversation && sessionView && conversation.sessionId === sessionView.sessionId
      ? { conversation, sessionView, configuredProjectPath: project.targetProjectPath }
      : undefined;
  };
  const existing = inspect();
  if (existing instanceof Error) return Promise.reject(existing);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("The Lead Agent did not identify the configured gateway project in time."));
    }, timeoutMs);
    const unsubscribe = client.onTranscriptEntry(() => {
      const ready = inspect();
      if (!ready) return;
      clearTimeout(timeout);
      unsubscribe();
      ready instanceof Error ? reject(ready) : resolve(ready);
    });
  });
}

function latestLegacySessionView(
  transcript: readonly LeadHostTranscriptEntry[],
): SessionViewSnapshot | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const event = gatewayEvents(transcript[index]!).find((candidate) =>
      candidate.type === "session-view"
    );
    if (event?.type === "session-view") return event.sessionView;
  }
  return undefined;
}

function latestConfiguredProjects(
  transcript: readonly LeadHostTranscriptEntry[],
): HostedOwnerProject[] | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]!;
    if (entry.source !== "lead" || entry.stream !== "stdout") continue;
    const projects = decodeHostedOwnerProjects(entry.line);
    if (projects) return projects;
  }
  return undefined;
}

function latestConversation(
  transcript: readonly LeadHostTranscriptEntry[],
  projectPath?: string,
  sessionId?: string,
  matchSession = false,
): HostedOwnerConversation | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const conversation = conversationFrame(transcript[index]!);
    if (!conversation) continue;
    if (projectPath && !sameProjectPath(conversation.targetProjectPath, projectPath)) continue;
    if (matchSession && conversation.sessionId !== sessionId) continue;
    return conversation;
  }
  return undefined;
}

function latestSessionView(
  transcript: readonly LeadHostTranscriptEntry[],
  projectPath: string,
  sessionId?: string,
  matchSession = false,
): HostedOwnerSessionView<SessionViewSnapshot> | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const view = sessionViewFrame(transcript[index]!);
    if (
      view &&
      sameProjectPath(view.targetProjectPath, projectPath) &&
      (!matchSession || view.sessionId === sessionId)
    ) return view;
  }
  return undefined;
}

function conversationFrame(entry: LeadHostTranscriptEntry): HostedOwnerConversation | undefined {
  return entry.source === "lead" && entry.stream === "stdout"
    ? decodeHostedOwnerConversation(entry.line)
    : undefined;
}

function sessionViewFrame(
  entry: LeadHostTranscriptEntry,
): HostedOwnerSessionView<SessionViewSnapshot> | undefined {
  return entry.source === "lead" && entry.stream === "stdout"
    ? decodeHostedOwnerSessionView<SessionViewSnapshot>(entry.line)
    : undefined;
}

function projectIdentity(path: string): ProjectIdentity {
  const absolutePath = resolve(path);
  const canonicalPath = realpathSync.native(absolutePath);
  const normalized = canonicalPath.replaceAll("\\", "/").replace(/\/$/, "");
  return {
    canonicalPath,
    comparisonKey: process.platform === "win32" ? normalized.toLowerCase() : normalized,
  };
}

function sameProjectIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return left.comparisonKey === right.comparisonKey;
}

function sameProjectPath(left: string, right: string): boolean {
  return sameProjectIdentity(projectIdentity(left), projectIdentity(right));
}
