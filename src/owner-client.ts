import { resolve } from "node:path";

import {
  connectLocalLeadHost,
  localLeadHostAddress,
  type LeadHostTranscriptEntry,
  type LocalLeadHostClient,
} from "./local-host/index.ts";
import {
  runPiOwnerInterface,
  type PiOwnerTranscriptEntry,
} from "./pi-owner-interface.ts";
import { completeHostedOwnerInput } from "./owner-host-bridge.ts";
import type { SessionViewSnapshot } from "./session-view/index.ts";

const installRoot = requiredArgument("--install-root");

try {
  await runOwnerClient(installRoot);
} catch (error) {
  process.stderr.write(
    `CMD_RIKER_OWNER_INTERFACE_FAILURE: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}

async function runOwnerClient(installationRoot: string): Promise<void> {
  const client = await connectWithRetry(localLeadHostAddress(resolve(installationRoot)), 10_000);
  const targetProjectPath = await waitForTargetProjectPath(client, 60_000);
  try {
    await runPiOwnerInterface({
      targetProjectPath,
      transcript: readTranscript(client.transcript),
      completeOwnerInput: (ownerInput) => completeHostedOwnerInput(client, ownerInput),
      readSessionView: () => readLatestSessionView(client.transcript),
      readSessionData: () => readLatestSessionData(client.transcript),
      subscribeNotices: (listener) =>
        client.onTranscriptEntry((entry: LeadHostTranscriptEntry) => {
          const prefix = "CMD_RIKER_WORKER_NOTICE: ";
          if (entry.source === "lead" && entry.stream === "stdout" && entry.line.startsWith(prefix)) {
            listener(entry.line.slice(prefix.length));
          }
        }),
    });
  } finally {
    await client.detach();
  }
}

// The Lead prints its Target Project during boot; a freshly started host has an
// open pipe before that line exists, so wait for it instead of reading once.
function waitForTargetProjectPath(
  client: LocalLeadHostClient,
  timeoutMs: number,
): Promise<string> {
  const prefix = "CMD Riker | Target Project:";
  const parse = (entry: LeadHostTranscriptEntry): string | undefined =>
    entry.source === "lead" && entry.stream === "stdout" && entry.line.startsWith(prefix)
      ? entry.line.slice(prefix.length).trim()
      : undefined;
  for (let index = client.transcript.length - 1; index >= 0; index -= 1) {
    const found = parse(client.transcript[index]!);
    if (found !== undefined) return Promise.resolve(found);
  }
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("The Lead Agent did not identify its Target Project in time."));
    }, timeoutMs);
    const unsubscribe = client.onTranscriptEntry((entry) => {
      const found = parse(entry);
      if (found === undefined) return;
      clearTimeout(timeout);
      unsubscribe();
      resolvePromise(found);
    });
  });
}

function readLatestSessionView(transcript: readonly LeadHostTranscriptEntry[]): string {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (
      entry?.source === "lead" &&
      entry.stream === "stdout" &&
      /^Lead (?:available|responding)\s+\|/.test(entry.line)
    ) {
      return entry.line;
    }
  }
  return "Lead starting | Worker Sessions unavailable | status pending";
}

function readLatestSessionData(
  transcript: readonly LeadHostTranscriptEntry[],
): SessionViewSnapshot | undefined {
  const prefix = "CMD_RIKER_SESSION_JSON:";
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry?.source !== "lead" || entry.stream !== "stdout") continue;
    if (!entry.line.startsWith(prefix)) continue;
    try {
      return JSON.parse(entry.line.slice(prefix.length)) as SessionViewSnapshot;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readTranscript(
  transcript: readonly LeadHostTranscriptEntry[],
): PiOwnerTranscriptEntry[] {
  const result: PiOwnerTranscriptEntry[] = [];
  for (const entry of transcript) {
    if (entry.source === "owner") {
      result.push({ source: "owner", content: entry.line });
      continue;
    }
    if (entry.stream !== "stdout") continue;
    if (entry.line.startsWith("Lead Agent: ")) {
      result.push({ source: "lead-agent", content: entry.line.slice("Lead Agent: ".length) });
    } else if (entry.line.startsWith("Session View: ")) {
      result.push({ source: "lead-agent", content: entry.line.slice("Session View: ".length) });
    }
  }
  return result;
}

async function connectWithRetry(address: string, timeoutMs: number): Promise<LocalLeadHostClient> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectLocalLeadHost(address);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error("Timed out waiting for the protected Lead Agent.", { cause: lastError });
}

function requiredArgument(name: string): string {
  const index = process.argv.lastIndexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
