import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  decodeHostedOwnerResponse,
  encodeHostedOwnerInput,
  ownerConversationPrefix,
  ownerTurnCompleteMarker,
} from "../owner-host-framing.ts";
import type { PiOwnerResponse } from "../pi-owner-interface.ts";

const defaultTranscriptByteLimit = 256 * 1024;
const defaultStopGraceMs = 2_000;
const defaultDurableOwnerAckTimeoutMs = 15_000;
const targetProjectPrefix = "CMD Riker | Target Project:";
const sessionViewPrefix = "CMD_RIKER_SESSION_JSON:";

export type LeadHostState = "starting" | "available" | "responding";

export type LeadHostTranscriptEntry =
  | { source: "owner"; line: string }
  | { source: "lead"; stream: "stdout" | "stderr"; line: string };

export type LeadHostExit =
  | { kind: "explicit-stop"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "graceful-shutdown"; code: number | null; signal: NodeJS.Signals | null }
  | {
      kind: "unexpected-child-exit";
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: string;
    };

export type LocalLeadHostServer = {
  readonly address: string;
  readonly childPid: number;
  readonly exit: Promise<LeadHostExit>;
  stop(): Promise<LeadHostExit>;
  shutdown(): Promise<LeadHostExit>;
};

export type LocalLeadHostClient = {
  readonly address: string;
  readonly childPid: number;
  readonly leadState: LeadHostState;
  readonly transcript: readonly LeadHostTranscriptEntry[];
  readonly exit: Promise<LeadHostExit>;
  sendOwnerLine(line: string): Promise<void>;
  completeOwnerTurn(input: string): Promise<PiOwnerResponse>;
  stop(): Promise<LeadHostExit>;
  detach(): Promise<void>;
  onTranscriptEntry(listener: (entry: LeadHostTranscriptEntry) => void): () => void;
  onExit(listener: (exit: LeadHostExit) => void): () => void;
};

export type StartLocalLeadHostOptions = {
  address: string;
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  transcriptSeed?: readonly LeadHostTranscriptEntry[];
  transcriptByteLimit?: number;
  stopGraceMs?: number;
  durableOwnerAckPrefix?: string;
  ownerHandledMarker?: string;
  /** Frames multiline Owner content into one physical child-stdin line. */
  encodeOwnerInput?: boolean;
  /** Marks semantic Owner turn completion for host-wide response correlation. */
  ownerTurnCompletePrefix?: string;
  durableOwnerAckTimeoutMs?: number;
  onStopIntent: () => Promise<void>;
  /** Observes live transcript entries (not the seed); must not disturb the host. */
  onTranscriptEntry?: (entry: LeadHostTranscriptEntry) => void;
};

type ClientRequest =
  | { type: "attach" }
  | { type: "owner"; requestId: number; line: string }
  | { type: "turn"; requestId: number; input: string }
  | { type: "stop"; requestId: number };

type ServerMessage =
  | {
      type: "attached";
      childPid: number;
      leadState: LeadHostState;
      transcript: LeadHostTranscriptEntry[];
    }
  | { type: "entry"; entry: LeadHostTranscriptEntry }
  | { type: "lead-state"; state: LeadHostState }
  | { type: "ack"; requestId: number }
  | { type: "turn-result"; requestId: number; response: PiOwnerResponse }
  | { type: "request-error"; requestId: number; message: string }
  | { type: "exit"; exit: LeadHostExit };

export function localLeadHostAddress(installationDirectory: string): string {
  const identity = resolve(installationDirectory).replaceAll("\\", "/").toLowerCase();
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\cmd-riker-lead-${digest}`
    : join(tmpdir(), `cmd-riker-lead-${digest}.sock`);
}

export async function startLocalLeadHost(
  options: StartLocalLeadHostOptions,
): Promise<LocalLeadHostServer> {
  if (!options.address) throw new Error("The local Lead Agent host address is required.");
  if (!options.executable) throw new Error("The Lead Agent executable is required.");
  const transcriptByteLimit = options.transcriptByteLimit ?? defaultTranscriptByteLimit;
  if (!Number.isSafeInteger(transcriptByteLimit) || transcriptByteLimit <= 0) {
    throw new Error("transcriptByteLimit must be a positive safe integer.");
  }
  const stopGraceMs = options.stopGraceMs ?? defaultStopGraceMs;
  if (!Number.isSafeInteger(stopGraceMs) || stopGraceMs < 0) {
    throw new Error("stopGraceMs must be a non-negative safe integer.");
  }
  const durableOwnerAckTimeoutMs = options.durableOwnerAckTimeoutMs ??
    defaultDurableOwnerAckTimeoutMs;
  if (!Number.isSafeInteger(durableOwnerAckTimeoutMs) || durableOwnerAckTimeoutMs < 1) {
    throw new Error("durableOwnerAckTimeoutMs must be a positive safe integer.");
  }

  const server = createServer();
  await listen(server, options.address);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.executable, [...options.args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    await childStarted(child);
  } catch (error) {
    await closeListeningServer(server);
    throw error;
  }

  const sockets = new Map<Socket, { attached: boolean }>();
  const transcript: LeadHostTranscriptEntry[] = [];
  const stickyEntries = new Map<
    "target-project" | "session-view" | "conversation",
    LeadHostTranscriptEntry
  >();
  let transcriptBytes = 0;
  let leadState: LeadHostState = "starting";
  let acceptingOwnerLines = true;
  let controlledChildShutdown = false;
  let childError: Error | undefined;
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let writeQueue = Promise.resolve();
  let semanticTurnQueue = Promise.resolve();
  let activeSemanticTurn:
    | {
        response?: PiOwnerResponse;
        completion: ReturnType<typeof Promise.withResolvers<PiOwnerResponse>>;
      }
    | undefined;
  const durableOwnerAcks: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  let stopOperation: Promise<LeadHostExit> | undefined;
  let shutdownOperation: Promise<LeadHostExit> | undefined;
  let finalizeOperation: Promise<LeadHostExit> | undefined;
  const exitResolution = Promise.withResolvers<LeadHostExit>();

  const rememberStickyEntry = (entry: LeadHostTranscriptEntry): void => {
    if (entry.source !== "lead" || entry.stream !== "stdout") return;
    if (entry.line.startsWith(targetProjectPrefix)) stickyEntries.set("target-project", entry);
    else if (entry.line.startsWith(sessionViewPrefix)) stickyEntries.set("session-view", entry);
    else if (entry.line.startsWith(ownerConversationPrefix)) stickyEntries.set("conversation", entry);
  };
  const appendTranscript = (entry: LeadHostTranscriptEntry): void => {
    rememberStickyEntry(entry);
    const bytes = entryBytes(entry);
    transcript.push(entry);
    transcriptBytes += bytes;
    while (transcriptBytes > transcriptByteLimit && transcript.length > 0) {
      const removed = transcript.shift();
      if (removed) transcriptBytes -= entryBytes(removed);
    }
  };

  for (const entry of options.transcriptSeed ?? []) appendTranscript(entry);

  const send = (socket: Socket, message: ServerMessage): void => {
    if (!socket.destroyed && !socket.readableEnded && !socket.writableEnded) {
      socket.write(`${JSON.stringify(message)}\n`);
    }
  };

  const broadcast = (message: ServerMessage): void => {
    for (const [socket, state] of sockets) {
      if (state.attached) send(socket, message);
    }
  };

  const recordEntry = (entry: LeadHostTranscriptEntry): void => {
    appendTranscript(entry);
    try {
      options.onTranscriptEntry?.(entry);
    } catch {
      // A failing observer must never take the Lead Agent host down with it.
    }
    broadcast({ type: "entry", entry });
  };

  const finalize = (exit: LeadHostExit): Promise<LeadHostExit> => {
    if (finalizeOperation) return finalizeOperation;
    acceptingOwnerLines = false;
    finalizeOperation = (async () => {
      const closed = closeListeningServer(server);
      for (const socket of sockets.keys()) {
        if (socket.destroyed) continue;
        socket.write(`${JSON.stringify({ type: "exit", exit } satisfies ServerMessage)}\n`, () => {
          socket.end();
        });
      }
      await closed;
      exitResolution.resolve(exit);
      return exit;
    })();
    return finalizeOperation;
  };

  const unexpectedExit = (): LeadHostExit => ({
    kind: "unexpected-child-exit",
    code: childExit?.code ?? null,
    signal: childExit?.signal ?? null,
    ...(childError ? { error: childError.message } : {}),
  });

  child.once("error", (error) => {
    childError = error;
  });
  child.once("close", (code, signal) => {
    childExit = { code, signal };
    for (const acknowledgement of durableOwnerAcks.splice(0)) {
      acknowledgement.reject(new Error("The Lead Agent exited before Owner input became durable."));
    }
    activeSemanticTurn?.completion.reject(
      new Error("The Lead Agent exited before the Owner turn completed."),
    );
    if (!controlledChildShutdown && !stopOperation) void finalize(unexpectedExit());
  });
  readLines(child.stdout, (line) => {
    if (
      (options.durableOwnerAckPrefix && line.startsWith(options.durableOwnerAckPrefix)) ||
      (options.ownerHandledMarker && line === options.ownerHandledMarker)
    ) {
      durableOwnerAcks.shift()?.resolve();
      return;
    }
    const response = decodeHostedOwnerResponse(line);
    if (response && activeSemanticTurn) activeSemanticTurn.response = response;
    recordEntry({ source: "lead", stream: "stdout", line });
    if (leadState === "starting" && line.startsWith(sessionViewPrefix)) setLeadState("available");
    if (line === ownerTurnCompleteMarker) setLeadState("available");
    if (
      options.ownerTurnCompletePrefix &&
      line.startsWith(options.ownerTurnCompletePrefix) &&
      activeSemanticTurn
    ) {
      if (activeSemanticTurn.response) {
        activeSemanticTurn.completion.resolve(activeSemanticTurn.response);
      } else {
        activeSemanticTurn.completion.reject(
          new Error("The Lead Agent completed the Owner turn without a framed response."),
        );
      }
    }
  });
  readLines(child.stderr, (line) => recordEntry({ source: "lead", stream: "stderr", line }));

  const writeOwnerLine = (line: string): Promise<void> => {
    const queued = writeQueue.then(async () => {
      if (!acceptingOwnerLines || childExit) {
        throw new Error("The local Lead Agent host is stopping or has exited.");
      }
      const acknowledgement = options.durableOwnerAckPrefix
        ? Promise.withResolvers<void>()
        : undefined;
      if (acknowledgement) durableOwnerAcks.push(acknowledgement);
      try {
        await writeLine(child, options.encodeOwnerInput ? encodeHostedOwnerInput(line) : line);
        if (acknowledgement) {
          await Promise.race([
            acknowledgement.promise,
            new Promise<never>((_resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error("Lead Agent did not durably acknowledge Owner input before deadline.")),
                durableOwnerAckTimeoutMs,
              );
              timer.unref();
            }),
          ]);
        }
      } catch (error) {
        if (acknowledgement) {
          const index = durableOwnerAcks.indexOf(acknowledgement);
          if (index >= 0) durableOwnerAcks.splice(index, 1);
        }
        throw error;
      }
      recordEntry({ source: "owner", line });
      setLeadState("responding");
    });
    writeQueue = queued.catch(() => {});
    return queued;
  };

  const setLeadState = (state: LeadHostState): void => {
    if (leadState === state) return;
    leadState = state;
    broadcast({ type: "lead-state", state });
  };

  const completeOwnerTurn = (input: string): Promise<PiOwnerResponse> => {
    if (!options.ownerTurnCompletePrefix) {
      return Promise.reject(new Error("Semantic Owner turns are unavailable on this host."));
    }
    const operation = semanticTurnQueue.then(async () => {
      const completion = Promise.withResolvers<PiOwnerResponse>();
      // Child exit may reject both delivery and completion in the same tick.
      void completion.promise.catch(() => {});
      activeSemanticTurn = { completion };
      const timeout = setTimeout(() => {
        completion.reject(new Error("The Lead Agent did not finish the Owner turn within one hour."));
      }, 60 * 60_000);
      timeout.unref();
      try {
        await writeOwnerLine(input);
        return await completion.promise;
      } finally {
        clearTimeout(timeout);
        activeSemanticTurn = undefined;
      }
    });
    semanticTurnQueue = operation.then(() => {}, () => {});
    return operation;
  };

  const requestStop = (): Promise<LeadHostExit> => {
    if (finalizeOperation) return finalizeOperation;
    if (stopOperation) return stopOperation;
    acceptingOwnerLines = false;
    stopOperation = (async () => {
      try {
        await options.onStopIntent();
      } catch (error) {
        if (childExit) return finalize(unexpectedExit());
        acceptingOwnerLines = true;
        stopOperation = undefined;
        throw error;
      }

      await writeQueue;

      if (childExit) return finalize(unexpectedExit());
      controlledChildShutdown = true;
      child.stdin.end();
      await waitForChildClose(child, stopGraceMs);
      const cleanExit: LeadHostExit = {
        kind: "explicit-stop",
        code: child.exitCode,
        signal: child.signalCode,
      };
      return finalize(cleanExit);
    })();
    return stopOperation;
  };

  const requestShutdown = (): Promise<LeadHostExit> => {
    if (finalizeOperation) return finalizeOperation;
    if (stopOperation) return stopOperation;
    if (shutdownOperation) return shutdownOperation;
    acceptingOwnerLines = false;
    shutdownOperation = (async () => {
      await writeQueue;
      if (childExit) return finalize(unexpectedExit());
      controlledChildShutdown = true;
      child.stdin.end();
      await waitForChildClose(child, stopGraceMs);
      return finalize({
        kind: "graceful-shutdown",
        code: child.exitCode,
        signal: child.signalCode,
      });
    })();
    return shutdownOperation;
  };

  server.on("connection", (socket) => {
    sockets.set(socket, { attached: false });
    socket.on("end", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on("close", () => sockets.delete(socket));
    readLines(socket, (line) => {
      let request: ClientRequest;
      try {
        request = JSON.parse(line) as ClientRequest;
      } catch {
        socket.destroy(new Error("Invalid local Lead Agent host request."));
        return;
      }
      const state = sockets.get(socket);
      if (!state) return;
      if (request.type === "attach" && !state.attached) {
        state.attached = true;
        const replay = [...transcript];
        for (const entry of stickyEntries.values()) {
          if (!replay.includes(entry)) replay.unshift(entry);
        }
        send(socket, {
          type: "attached",
          childPid: child.pid!,
          leadState,
          transcript: replay,
        });
        return;
      }
      if (!state.attached) {
        socket.destroy(new Error("Attach must be the first local host request."));
        return;
      }
      if (request.type === "owner") {
        if (options.ownerTurnCompletePrefix) {
          send(socket, {
            type: "request-error",
            requestId: request.requestId,
            message: "This host requires correlated Owner turns.",
          });
          return;
        }
        if (typeof request.line !== "string" || (!options.encodeOwnerInput && !isSingleLine(request.line))) {
          send(socket, {
            type: "request-error",
            requestId: request.requestId,
            message: "Owner input must be exactly one line.",
          });
          return;
        }
        void writeOwnerLine(request.line).then(
          () => send(socket, { type: "ack", requestId: request.requestId }),
          (error: unknown) =>
            send(socket, {
              type: "request-error",
              requestId: request.requestId,
              message: error instanceof Error ? error.message : "Owner input delivery failed.",
            }),
        );
        return;
      }
      if (request.type === "turn") {
        if (typeof request.input !== "string") {
          send(socket, {
            type: "request-error",
            requestId: request.requestId,
            message: "Owner turn input must be a string.",
          });
          return;
        }
        void completeOwnerTurn(request.input).then(
          (response) => send(socket, { type: "turn-result", requestId: request.requestId, response }),
          (error: unknown) => send(socket, {
            type: "request-error",
            requestId: request.requestId,
            message: error instanceof Error ? error.message : "The Owner turn failed.",
          }),
        );
        return;
      }
      if (request.type === "stop") {
        void requestStop().catch((error: unknown) => {
          send(socket, {
            type: "request-error",
            requestId: request.requestId,
            message: error instanceof Error ? error.message : "The stop intent could not be recorded.",
          });
        });
      }
    });
  });

  return {
    address: options.address,
    childPid: child.pid!,
    exit: exitResolution.promise,
    stop: requestStop,
    shutdown: requestShutdown,
  };
}

export async function connectLocalLeadHost(address: string): Promise<LocalLeadHostClient> {
  const socket = createConnection(address);
  await socketConnected(socket);

  const transcript: LeadHostTranscriptEntry[] = [];
  const entryListeners = new Set<(entry: LeadHostTranscriptEntry) => void>();
  const exitListeners = new Set<(exit: LeadHostExit) => void>();
  const pending = new Map<
    number,
    {
      kind: "owner" | "stop";
      resolution: ReturnType<typeof Promise.withResolvers<void>>;
    }
  >();
  const pendingTurns = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<PiOwnerResponse>>
  >();
  const attached = Promise.withResolvers<number>();
  const exitResolution = Promise.withResolvers<LeadHostExit>();
  let nextRequestId = 1;
  let observedExit: LeadHostExit | undefined;
  let leadState: LeadHostState = "starting";
  let detached = false;

  readLines(socket, (line) => {
    const message = JSON.parse(line) as ServerMessage;
    if (message.type === "attached") {
      transcript.push(...message.transcript);
      leadState = message.leadState;
      attached.resolve(message.childPid);
      return;
    }
    if (message.type === "lead-state") {
      leadState = message.state;
      return;
    }
    if (message.type === "entry") {
      transcript.push(message.entry);
      for (const listener of entryListeners) listener(message.entry);
      return;
    }
    if (message.type === "ack") {
      pending.get(message.requestId)?.resolution.resolve();
      pending.delete(message.requestId);
      return;
    }
    if (message.type === "turn-result") {
      pendingTurns.get(message.requestId)?.resolve(message.response);
      pendingTurns.delete(message.requestId);
      return;
    }
    if (message.type === "request-error") {
      pending.get(message.requestId)?.resolution.reject(new Error(message.message));
      pending.delete(message.requestId);
      pendingTurns.get(message.requestId)?.reject(new Error(message.message));
      pendingTurns.delete(message.requestId);
      return;
    }
    observedExit = message.exit;
    exitResolution.resolve(message.exit);
    for (const request of pending.values()) {
      if (request.kind === "stop") request.resolution.resolve();
      else request.resolution.reject(new Error("The Lead Agent exited before input was acknowledged."));
    }
    pending.clear();
    for (const turn of pendingTurns.values()) {
      turn.reject(new Error("The Lead Agent exited before the Owner turn completed."));
    }
    pendingTurns.clear();
    for (const listener of exitListeners) listener(message.exit);
  });
  socket.once("error", (error) => {
    attached.reject(error);
    for (const request of pending.values()) request.resolution.reject(error);
    pending.clear();
    for (const turn of pendingTurns.values()) turn.reject(error);
    pendingTurns.clear();
  });
  socket.once("close", () => {
    if (!detached && !observedExit) {
      const error = new Error("The local Lead Agent host connection closed without a terminal outcome.");
      attached.reject(error);
      for (const request of pending.values()) request.resolution.reject(error);
      pending.clear();
      for (const turn of pendingTurns.values()) turn.reject(error);
      pendingTurns.clear();
    }
  });
  socket.write(`${JSON.stringify({ type: "attach" } satisfies ClientRequest)}\n`);
  const childPid = await attached.promise;

  const request = (
    kind: "owner" | "stop",
    message: (requestId: number) => ClientRequest,
  ): Promise<void> => {
    if (detached || socket.destroyed) {
      return Promise.reject(new Error("The local Lead Agent host client is detached."));
    }
    const requestId = nextRequestId++;
    const resolution = Promise.withResolvers<void>();
    pending.set(requestId, { kind, resolution });
    socket.write(`${JSON.stringify(message(requestId))}\n`, (error) => {
      if (!error) return;
      pending.delete(requestId);
      resolution.reject(error);
    });
    return resolution.promise;
  };

  return {
    address,
    childPid,
    get leadState() {
      return leadState;
    },
    get transcript() {
      return transcript;
    },
    exit: exitResolution.promise,
    sendOwnerLine(line) {
      return request("owner", (requestId) => ({ type: "owner", requestId, line }));
    },
    completeOwnerTurn(input) {
      if (detached || socket.destroyed) {
        return Promise.reject(new Error("The local Lead Agent host client is detached."));
      }
      const requestId = nextRequestId++;
      const resolution = Promise.withResolvers<PiOwnerResponse>();
      pendingTurns.set(requestId, resolution);
      socket.write(
        `${JSON.stringify({ type: "turn", requestId, input } satisfies ClientRequest)}\n`,
        (error) => {
          if (!error) return;
          pendingTurns.delete(requestId);
          resolution.reject(error);
        },
      );
      return resolution.promise;
    },
    async stop() {
      const stopRequest = request("stop", (requestId) => ({ type: "stop", requestId }));
      return Promise.race([
        exitResolution.promise,
        stopRequest.then(() => exitResolution.promise),
      ]);
    },
    async detach() {
      if (detached) return;
      detached = true;
      const error = new Error("The local Lead Agent host client detached.");
      for (const request of pending.values()) request.resolution.reject(error);
      pending.clear();
      for (const turn of pendingTurns.values()) turn.reject(error);
      pendingTurns.clear();
      if (socket.destroyed) return;
      const closed = Promise.withResolvers<void>();
      socket.once("close", () => closed.resolve());
      socket.end();
      await closed.promise;
    },
    onTranscriptEntry(listener) {
      entryListeners.add(listener);
      return () => entryListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      if (observedExit) listener(observedExit);
      return () => exitListeners.delete(listener);
    },
  };
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });
}

function childStarted(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    const onSpawn = (): void => {
      child.off("error", onError);
      resolvePromise();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

function socketConnected(socket: Socket): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      socket.off("connect", onConnect);
      reject(error);
    };
    const onConnect = (): void => {
      socket.off("error", onError);
      resolvePromise();
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function closeListeningServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

function writeLine(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    child.stdin.write(`${line}\n`, (error) => (error ? reject(error) : resolvePromise()));
  });
}

async function waitForChildClose(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = Promise.withResolvers<void>();
  child.once("close", () => closed.resolve());
  const timer = setTimeout(() => child.kill(), graceMs);
  timer.unref();
  await closed.promise;
  clearTimeout(timer);
}

function readLines(
  input: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  let buffered = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      onLine(line);
      newline = buffered.indexOf("\n");
    }
  });
  input.on("end", () => {
    if (buffered) onLine(buffered.replace(/\r$/, ""));
  });
}

function isSingleLine(line: unknown): line is string {
  return typeof line === "string" && !line.includes("\n") && !line.includes("\r");
}

function entryBytes(entry: LeadHostTranscriptEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
}
