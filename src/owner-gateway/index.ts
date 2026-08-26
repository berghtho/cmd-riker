import type { PiOwnerResponse } from "../pi-owner-interface.ts";
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
  ownerTurnCompleteMarker,
  type HostedOwnerConversation,
  type HostedOwnerConversationEntry,
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
  options: { connectTimeoutMs?: number; readyTimeoutMs?: number } = {},
): Promise<OwnerGatewayClient> {
  const client = await connectLocalHostWithRetry(address, options.connectTimeoutMs ?? 0);
  const initialConversation = await waitForReadySnapshot(
    client,
    options.readyTimeoutMs ?? 60_000,
  ).catch(async (error: unknown) => {
    await client.detach();
    throw error;
  });
  const listeners = new Set<(event: OwnerGatewayEvent) => void>();
  let activeSessionId = initialConversation.sessionId;
  let ownerSessionRevision = 1;

  const publish = (event: OwnerGatewayEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A presentation adapter must not disturb the hosted Lead Agent.
      }
    }
  };
  const unsubscribeTranscript = client.onTranscriptEntry((entry) => {
    const conversation = conversationFrame(entry);
    if (conversation) {
      const replaced = conversation.sessionId !== activeSessionId;
      if (replaced) {
        activeSessionId = conversation.sessionId;
        ownerSessionRevision += 1;
      }
      publish({
        type: "conversation",
        conversation: conversation.entries,
        targetProjectPath: conversation.targetProjectPath,
        ownerSessionRevision,
        replaced,
      });
      return;
    }
    for (const event of gatewayEvents(entry)) {
      publish(event.type === "session-view"
        ? { type: "session-view", sessionView: withLeadState(event.sessionView, client.leadState) }
        : event);
    }
  });
  const unsubscribeExit = client.onExit((exit) => publish({ type: "exit", exit }));

  return {
    childPid: client.childPid,
    get snapshot() {
      return gatewaySnapshot(client.transcript, client.leadState, ownerSessionRevision);
    },
    completeTurn(ownerInput) {
      return client.completeOwnerTurn(ownerInput);
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

function gatewaySnapshot(
  transcript: readonly LeadHostTranscriptEntry[],
  leadState: LeadHostState,
  ownerSessionRevision: number,
): OwnerGatewaySnapshot {
  let conversation = latestConversation(transcript);
  let sessionView: SessionViewSnapshot | undefined;
  for (const entry of transcript) {
    for (const event of gatewayEvents(entry)) {
      if (event.type === "session-view") sessionView = event.sessionView;
    }
  }
  return {
    targetProjectPath: conversation?.targetProjectPath ?? "",
    ownerSessionRevision,
    leadState,
    conversation: conversation?.entries ?? [],
    ...(sessionView ? { sessionView: withLeadState(sessionView, leadState) } : {}),
  };
}

function withLeadState(
  sessionView: SessionViewSnapshot,
  leadState: LeadHostState,
): SessionViewSnapshot {
  return leadState === "starting"
    ? sessionView
    : { ...sessionView, leadAvailability: leadState };
}

function gatewayEvents(entry: LeadHostTranscriptEntry): OwnerGatewayEvent[] {
  if (entry.source === "owner") return [{ type: "lead-state", state: "responding" }];
  if (entry.stream !== "stdout") return [];
  if (entry.line === ownerTurnCompleteMarker) {
    return [{ type: "lead-state", state: "available" }];
  }
  if (entry.line.startsWith(workerNoticePrefix)) {
    return [{ type: "notice", content: entry.line.slice(workerNoticePrefix.length) }];
  }
  if (entry.line.startsWith(sessionViewPrefix)) {
    try {
      const sessionView = JSON.parse(
        entry.line.slice(sessionViewPrefix.length),
      ) as SessionViewSnapshot;
      return [{ type: "session-view", sessionView }];
    } catch {
      return [];
    }
  }
  return [];
}

function waitForReadySnapshot(
  client: LocalLeadHostClient,
  timeoutMs: number,
): Promise<HostedOwnerConversation> {
  const existing = latestConversation(client.transcript);
  if (existing && hasSessionView(client.transcript)) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("The Lead Agent did not identify its Target Project in time."));
    }, timeoutMs);
    const unsubscribe = client.onTranscriptEntry((entry) => {
      const conversation = conversationFrame(entry) ?? latestConversation(client.transcript);
      if (!conversation || !hasSessionView(client.transcript)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(conversation);
    });
  });
}

function hasSessionView(transcript: readonly LeadHostTranscriptEntry[]): boolean {
  return transcript.some((entry) =>
    gatewayEvents(entry).some((event) => event.type === "session-view")
  );
}

function latestConversation(
  transcript: readonly LeadHostTranscriptEntry[],
): HostedOwnerConversation | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const conversation = conversationFrame(transcript[index]!);
    if (conversation) return conversation;
  }
  return undefined;
}

function conversationFrame(entry: LeadHostTranscriptEntry): HostedOwnerConversation | undefined {
  return entry.source === "lead" && entry.stream === "stdout"
    ? decodeHostedOwnerConversation(entry.line)
    : undefined;
}
