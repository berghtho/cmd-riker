import type { PiOwnerResponse } from "../pi-owner-interface.ts";
import {
  connectLocalLeadHost,
  type LeadHostExit,
  type LeadHostTranscriptEntry,
  type LocalLeadHostClient,
} from "../local-host/index.ts";
import { completeHostedOwnerInput } from "../owner-host-bridge.ts";
import type { SessionViewSnapshot } from "../session-view/index.ts";
import { decodeHostedOwnerResponse } from "../owner-host-framing.ts";

const targetProjectPrefix = "CMD Riker | Target Project:";
const sessionViewPrefix = "CMD_RIKER_SESSION_JSON:";
const workerNoticePrefix = "CMD_RIKER_WORKER_NOTICE: ";

export type OwnerGatewayConversationEntry = {
  source: "owner" | "lead-agent";
  content: string;
};

export type OwnerGatewaySnapshot = {
  targetProjectPath: string;
  conversation: OwnerGatewayConversationEntry[];
  sessionView?: SessionViewSnapshot;
};

export type OwnerGatewayEvent =
  | { type: "conversation-entry"; entry: OwnerGatewayConversationEntry }
  | { type: "session-view"; sessionView: SessionViewSnapshot }
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
  options: { readyTimeoutMs?: number } = {},
): Promise<OwnerGatewayClient> {
  const client = await connectLocalLeadHost(address);
  const targetProjectPath = await waitForReadySnapshot(
    client,
    options.readyTimeoutMs ?? 60_000,
  ).catch(async (error: unknown) => {
    await client.detach();
    throw error;
  });
  const listeners = new Set<(event: OwnerGatewayEvent) => void>();
  let turnQueue = Promise.resolve();

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
    const event = gatewayEvent(entry);
    if (event) publish(event);
  });
  const unsubscribeExit = client.onExit((exit) => publish({ type: "exit", exit }));

  return {
    childPid: client.childPid,
    get snapshot() {
      return gatewaySnapshot(client.transcript, targetProjectPath);
    },
    completeTurn(ownerInput) {
      const turn = turnQueue.then(() => completeHostedOwnerInput(client, ownerInput));
      turnQueue = turn.then(() => {}, () => {});
      return turn;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async detach() {
      await turnQueue;
      unsubscribeExit();
      unsubscribeTranscript();
      listeners.clear();
      await client.detach();
    },
  };
}

function gatewaySnapshot(
  transcript: readonly LeadHostTranscriptEntry[],
  targetProjectPath: string,
): OwnerGatewaySnapshot {
  const conversation: OwnerGatewayConversationEntry[] = [];
  let sessionView: SessionViewSnapshot | undefined;
  for (const entry of transcript) {
    const event = gatewayEvent(entry);
    if (event?.type === "conversation-entry") conversation.push(event.entry);
    if (event?.type === "session-view") sessionView = event.sessionView;
  }
  return {
    targetProjectPath,
    conversation,
    ...(sessionView ? { sessionView } : {}),
  };
}

function gatewayEvent(entry: LeadHostTranscriptEntry): OwnerGatewayEvent | undefined {
  if (entry.source === "owner") {
    return { type: "conversation-entry", entry: { source: "owner", content: entry.line } };
  }
  if (entry.stream !== "stdout") return undefined;
  const response = decodeHostedOwnerResponse(entry.line);
  if (response) {
    return {
      type: "conversation-entry",
      entry: { source: "lead-agent", content: response.content },
    };
  }
  if (entry.line.startsWith("Lead Agent: ")) {
    return {
      type: "conversation-entry",
      entry: { source: "lead-agent", content: entry.line.slice("Lead Agent: ".length) },
    };
  }
  if (entry.line.startsWith("Session View: ")) {
    return {
      type: "conversation-entry",
      entry: { source: "lead-agent", content: entry.line.slice("Session View: ".length) },
    };
  }
  if (entry.line.startsWith(workerNoticePrefix)) {
    return { type: "notice", content: entry.line.slice(workerNoticePrefix.length) };
  }
  if (entry.line.startsWith(sessionViewPrefix)) {
    try {
      return {
        type: "session-view",
        sessionView: JSON.parse(entry.line.slice(sessionViewPrefix.length)) as SessionViewSnapshot,
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function waitForReadySnapshot(
  client: LocalLeadHostClient,
  timeoutMs: number,
): Promise<string> {
  const existing = latestTargetProject(client.transcript);
  if (existing && hasSessionView(client.transcript)) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("The Lead Agent did not identify its Target Project in time."));
    }, timeoutMs);
    const unsubscribe = client.onTranscriptEntry((entry) => {
      const path = targetProject(entry) ?? latestTargetProject(client.transcript);
      if (!path || !hasSessionView(client.transcript)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(path);
    });
  });
}

function hasSessionView(transcript: readonly LeadHostTranscriptEntry[]): boolean {
  return transcript.some((entry) => gatewayEvent(entry)?.type === "session-view");
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
