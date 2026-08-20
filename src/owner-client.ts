import { resolve } from "node:path";

import {
  connectLocalLeadHost,
  localLeadHostAddress,
  type LeadHostTranscriptEntry,
  type LocalLeadHostClient,
} from "./local-host/index.ts";
import {
  runPiOwnerInterface,
  type PiOwnerResponse,
  type PiOwnerTranscriptEntry,
} from "./pi-owner-interface.ts";

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
  const targetProjectPath = readTargetProjectPath(client.transcript);
  try {
    await runPiOwnerInterface({
      targetProjectPath,
      transcript: readTranscript(client.transcript),
      completeOwnerInput: (ownerInput) => completeHostedOwnerInput(client, ownerInput),
      readSessionView: () => readLatestSessionView(client.transcript),
    });
  } finally {
    await client.detach();
  }
}

async function completeHostedOwnerInput(
  client: LocalLeadHostClient,
  ownerInput: string,
): Promise<PiOwnerResponse> {
  const completion = Promise.withResolvers<PiOwnerResponse>();
  const responseLines: string[] = [];
  let source: PiOwnerResponse["source"] = "Lead Agent";
  const unsubscribeTranscript = client.onTranscriptEntry((entry) => {
    if (entry.source !== "lead" || entry.stream !== "stdout") return;
    if (/^Lead available\s+\|/.test(entry.line)) {
      completion.resolve({ source, content: responseLines.join("\n").trim() });
      return;
    }
    if (entry.line.startsWith("Lead Agent: ")) {
      source = "Lead Agent";
      responseLines.push(entry.line.slice("Lead Agent: ".length));
      return;
    }
    if (entry.line.startsWith("Session View: ")) {
      source = "Session View";
      responseLines.push(entry.line.slice("Session View: ".length));
      return;
    }
    if (!entry.line.startsWith("CMD_RIKER_") && responseLines.length > 0) {
      responseLines.push(entry.line);
    }
  });
  const unsubscribeExit = client.onExit((exit) => {
    completion.reject(new Error(`The Lead Agent stopped unexpectedly (${exit.kind}).`));
  });
  const timeout = setTimeout(() => {
    completion.reject(new Error("The Lead Agent did not finish the Owner turn within ten minutes."));
  }, 10 * 60_000);
  try {
    await client.sendOwnerLine(ownerInput);
    return await completion.promise;
  } finally {
    clearTimeout(timeout);
    unsubscribeExit();
    unsubscribeTranscript();
  }
}

function readTargetProjectPath(transcript: readonly LeadHostTranscriptEntry[]): string {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry?.source !== "lead" || entry.stream !== "stdout") continue;
    const prefix = "CMD Riker | Target Project:";
    if (entry.line.startsWith(prefix)) return entry.line.slice(prefix.length).trim();
  }
  throw new Error("The protected Lead Agent did not identify its Target Project.");
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
