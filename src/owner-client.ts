import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  connectLocalLeadHost,
  localLeadHostAddress,
  type LeadHostTranscriptEntry,
  type LocalLeadHostClient,
} from "./local-host/index.ts";
import {
  runPiOwnerInterface,
  type PiOwnerTranscriptEntry,
  type PiOwnerUpdateStatus,
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
      readUpdateStatus: createUpdateStatusReader(resolve(installationRoot)),
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

// The installed bundle records its source repository and commit; the client
// polls that repository's HEAD in the background so the interface can announce
// a newer version. Git failures or a missing source record simply disable the
// notice.
function createUpdateStatusReader(
  installationRoot: string,
): () => PiOwnerUpdateStatus | undefined {
  let status: PiOwnerUpdateStatus | undefined;
  let source: { repositoryPath: string; commit: string; revision: string } | undefined;
  try {
    const launcher = JSON.parse(
      readFileSync(join(installationRoot, "launcher", "installation.json"), "utf8"),
    ) as { leadAgent?: { path?: string; identity?: { revision?: string } } };
    const bundlePath = launcher.leadAgent?.path;
    if (bundlePath) {
      const record = JSON.parse(readFileSync(join(bundlePath, "source.json"), "utf8")) as {
        repositoryPath?: string;
        commit?: string;
      };
      if (record.repositoryPath && record.commit) {
        source = {
          repositoryPath: record.repositoryPath,
          commit: record.commit,
          revision: launcher.leadAgent?.identity?.revision ?? "installed",
        };
      }
    }
  } catch {
    // No durable source record: the update notice stays off.
  }
  if (source) {
    const record = source;
    const execute = promisify(execFile);
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const result = await execute(
          "git",
          ["-C", record.repositoryPath, "rev-parse", "HEAD"],
          { encoding: "utf8", timeout: 10_000, windowsHide: true },
        );
        const repositoryCommit = result.stdout.trim();
        status = /^[0-9a-f]{40}$/i.test(repositoryCommit)
          ? {
              installedRevision: record.revision,
              installedCommit: record.commit,
              repositoryCommit,
              updateAvailable: repositoryCommit.toLowerCase() !== record.commit.toLowerCase(),
            }
          : undefined;
      } catch {
        status = undefined;
      } finally {
        checking = false;
      }
    };
    void check();
    setInterval(() => void check(), 60_000).unref();
  }
  return () => status;
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
