import type { PiOwnerResponse } from "../pi-owner-interface.ts";
import {
  connectLocalLeadHost,
  type LeadHostExit,
  type LeadHostTranscriptEntry,
  type LocalLeadHostClient,
} from "../local-host/index.ts";
import type { SessionViewSnapshot } from "../session-view/index.ts";
import {
  decodeHostedOwnerConversation,
  type HostedOwnerConversationEntry,
} from "../owner-host-framing.ts";

const targetProjectPrefix = "CMD Riker | Target Project:";
const sessionViewPrefix = "CMD_RIKER_SESSION_JSON:";
const workerNoticePrefix = "CMD_RIKER_WORKER_NOTICE: ";

export type OwnerGatewayConversationEntry = HostedOwnerConversationEntry;

export type OwnerGatewaySnapshot = {
  targetProjectPath: string;
  conversation: OwnerGatewayConversationEntry[];
  sessionView?: SessionViewSnapshot;
};

export type OwnerGatewayEvent =
  | { type: "conversation"; conversation: OwnerGatewayConversationEntry[] }
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
  const targetProjectPath = await waitForReadySnapshot(
    client,
    options.readyTimeoutMs ?? 60_000,
  ).catch(async (error: unknown) => {
    await client.detach();
    throw error;
  });
  const listeners = new Set<(event: OwnerGatewayEvent) => void>();

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
    for (const event of gatewayEvents(entry)) publish(event);
  });
  const unsubscribeExit = client.onExit((exit) => publish({ type: "exit", exit }));

  return {
    childPid: client.childPid,
    get snapshot() {
      return gatewaySnapshot(client.transcript, targetProjectPath);
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
  targetProjectPath: string,
): OwnerGatewaySnapshot {
  let conversation: OwnerGatewayConversationEntry[] = [];
  let sessionView: SessionViewSnapshot | undefined;
  for (const entry of transcript) {
    for (const event of gatewayEvents(entry)) {
      if (event.type === "conversation") conversation = event.conversation;
      if (event.type === "session-view") sessionView = event.sessionView;
    }
  }
  return {
    targetProjectPath,
    conversation,
    ...(sessionView ? { sessionView } : {}),
  };
}

function gatewayEvents(entry: LeadHostTranscriptEntry): OwnerGatewayEvent[] {
  if (entry.source === "owner") return [{ type: "lead-state", state: "responding" }];
  if (entry.stream !== "stdout") return [];
  const conversation = decodeHostedOwnerConversation(entry.line);
  if (conversation) return [{ type: "conversation", conversation }];
  if (entry.line.startsWith(workerNoticePrefix)) {
    return [{ type: "notice", content: entry.line.slice(workerNoticePrefix.length) }];
  }
  if (entry.line.startsWith(sessionViewPrefix)) {
    try {
      const sessionView = JSON.parse(
        entry.line.slice(sessionViewPrefix.length),
      ) as SessionViewSnapshot;
      return [
        { type: "session-view", sessionView },
        { type: "lead-state", state: sessionView.leadAvailability },
      ];
    } catch {
      return [];
    }
  }
  return [];
}

function waitForReadySnapshot(
  client: LocalLeadHostClient,
  timeoutMs: number,
): Promise<string> {
  const existing = latestTargetProject(client.transcript);
  if (existing && hasSessionView(client.transcript) && hasConversation(client.transcript)) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("The Lead Agent did not identify its Target Project in time."));
    }, timeoutMs);
    const unsubscribe = client.onTranscriptEntry((entry) => {
      const path = targetProject(entry) ?? latestTargetProject(client.transcript);
      if (!path || !hasSessionView(client.transcript) || !hasConversation(client.transcript)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(path);
    });
  });
}

function hasSessionView(transcript: readonly LeadHostTranscriptEntry[]): boolean {
  return transcript.some((entry) =>
    gatewayEvents(entry).some((event) => event.type === "session-view")
  );
}

function hasConversation(transcript: readonly LeadHostTranscriptEntry[]): boolean {
  return transcript.some((entry) =>
    gatewayEvents(entry).some((event) => event.type === "conversation")
  );
}

function latestTargetProject(transcript: readonly LeadHostTranscriptEntry[]): string | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const path = targetProject(transcript[index]!);
    if (path) return path;
  }
  return undefined;
}

function targetProject(entry: LeadHostTranscriptEntry): string | undefined {
  return entry.source === "lead" &&
      entry.stream === "stdout" &&
      entry.line.startsWith(targetProjectPrefix)
    ? entry.line.slice(targetProjectPrefix.length).trim()
    : undefined;
}
