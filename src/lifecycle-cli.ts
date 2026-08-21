import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { openAuthoritativeState } from "./authoritative-state/index.ts";
import {
  createLocalInstallation,
  localInstallationPaths,
  readGeneration,
  readLifecycle,
  type LocalInstallation,
} from "./local-installation/index.ts";
import {
  localLeadHostAddress,
  startLocalLeadHost,
  type LeadHostTranscriptEntry,
} from "./local-host/index.ts";
import { verifyLocalReleaseCandidate } from "./local-release/index.ts";

const command = process.argv[2];

try {
  if (!command) throw usage();
  const installRoot = argumentValue("--install-root") ?? inferredInstallRoot();
  const installation = createLocalInstallation({ installationRoot: installRoot });
  if (command === "host") await host(installRoot);
  else if (command === "install") await install(installation, installRoot);
  else if (command === "start") await attach(await installation.start());
  else if (command === "stop") await installation.stop();
  else if (command === "inspect") {
    process.stdout.write(`${JSON.stringify(await installation.inspect(), null, 2)}\n`);
  } else if (command === "upgrade") {
    const result = await installation.upgrade({
      leadAgentCandidateDirectory: requiredArgument("--lead-bundle"),
      stateRevision: requiredArgument("--state-revision"),
      stateProvenance: "Owner-supplied local upgrade",
    });
    await (await installation.start()).detach();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "rollback") {
    const result = await installation.rollback();
    await (await installation.start()).detach();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "uninstall") await installation.uninstall();
  else throw usage();
} catch (error) {
  process.stderr.write(`CMD_RIKER_LIFECYCLE_FAILURE: ${errorChain(error)}\n`);
  process.exitCode = 2;
}

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    if (!messages.includes(current.message)) messages.push(current.message);
    current = current.cause;
  }
  if (current !== undefined && current !== null) messages.push(String(current));
  return messages.join(" Caused by: ");
}

async function install(installation: LocalInstallation, installRoot: string): Promise<void> {
  const paths = localInstallationPaths(installRoot);
  await mkdir(paths.state, { recursive: true });
  const config = argumentValue("--config");
  if (config) await copyFile(config, join(paths.state, "config.json"));
  const result = await installation.initialInstall({
    leadAgentCandidateDirectory: requiredArgument("--lead-bundle"),
    stateRevision: argumentValue("--state-revision") ?? "initial-state",
    stateProvenance: "Owner-supplied initial local installation",
  });
  await (await installation.start()).detach();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// The detached host process: owns the singleton pipe, runs the Lead child, and
// restarts it on unexpected exits within a bounded budget. `riker start` spawns
// this and `riker stop` records the durable stop intent it honors.
async function host(installRoot: string): Promise<void> {
  const paths = localInstallationPaths(installRoot);
  let activeServer: Awaited<ReturnType<typeof startLocalLeadHost>> | undefined;
  let shutdownRequested = false;
  const gracefulShutdown = () => {
    shutdownRequested = true;
    void activeServer?.shutdown();
  };
  const shutdownSignals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;
  for (const signal of shutdownSignals) process.once(signal, gracefulShutdown);
  try {
    let restartsRemaining = 3;
    while (true) {
      const lifecycle = readLifecycle(paths.lifecycleJournal);
      if (!lifecycle || lifecycle.status !== "installed" || lifecycle.stopRequested) return;
      if (shutdownRequested) return;
      const release = await verifyLocalReleaseCandidate(lifecycle.active.code.path, "lead-agent");
      const generation = readGeneration(paths.state);
      if (shutdownRequested) return;
      try {
        const server = await startLocalLeadHost({
          address: localLeadHostAddress(paths.root),
          executable: release.runtime.path,
          args: [
            release.entrypointPath,
            "--state-dir",
            paths.state,
            "--write-generation",
            String(generation),
            "--hosted",
          ],
          transcriptSeed: conversationSeed(paths.state, generation),
          durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
          ownerHandledMarker: "CMD_RIKER_OWNER_HANDLED",
          async onStopIntent() {
            const current = readLifecycle(paths.lifecycleJournal);
            if (!current?.stopRequested) {
              throw new Error("The durable whole-system stop intent is missing.");
            }
          },
        });
        activeServer = server;
        const exit = await server.exit;
        activeServer = undefined;
        if (exit.kind === "explicit-stop" || exit.kind === "graceful-shutdown") return;
        process.stderr.write(
          `CMD_RIKER_LEAD_EXIT: Lead Agent exited unexpectedly with code ${exit.code ?? "none"} ` +
            `and signal ${exit.signal ?? "none"}.\n`,
        );
      } catch (error) {
        process.stderr.write(
          `CMD_RIKER_LEAD_LAUNCH_FAILURE: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        activeServer = undefined;
      }
      restartsRemaining -= 1;
      if (restartsRemaining <= 0) {
        process.stderr.write(
          "CMD_RIKER_LEAD_RESTART_EXHAUSTED: The Lead Agent keeps failing; run `riker start` " +
            "to retry or `riker rollback` to return to the previous version.\n",
        );
        return;
      }
    }
  } finally {
    for (const signal of shutdownSignals) process.off(signal, gracefulShutdown);
  }
}

async function attach(
  client: Awaited<ReturnType<LocalInstallation["start"]>>,
): Promise<void> {
  for (const entry of client.transcript) renderEntry(entry);
  const unsubscribe = client.onTranscriptEntry(renderEntry);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (line.trim()) await client.sendOwnerLine(line);
    }
  } finally {
    unsubscribe();
    await client.detach();
  }
}

function conversationSeed(stateDirectory: string, writeGeneration: number): LeadHostTranscriptEntry[] {
  const state = openAuthoritativeState(stateDirectory, { writeGeneration });
  try {
    return (state.readOwnerConversation()?.messages ?? []).map((message) =>
      message.role === "owner"
        ? { source: "owner" as const, line: message.content }
        : { source: "lead" as const, stream: "stdout" as const, line: `Lead Agent: ${message.content}` }
    );
  } finally {
    state.close();
  }
}

function renderEntry(entry: LeadHostTranscriptEntry): void {
  if (entry.source === "owner") process.stdout.write(`Owner: ${entry.line}\n`);
  else process[entry.stream === "stderr" ? "stderr" : "stdout"].write(`${entry.line}\n`);
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.lastIndexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function inferredInstallRoot(): string {
  const entrypoint = fileURLToPath(import.meta.url);
  const inferred = resolve(dirname(entrypoint), "..", "..", "..");
  if (inferred === resolve(process.cwd())) throw new Error("--install-root is required.");
  return inferred;
}

function requiredArgument(name: string): string {
  const value = argumentValue(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function usage(): Error {
  return new Error(
    "Usage: lifecycle-cli <install|start|stop|inspect|upgrade|rollback|uninstall|host> --install-root <path> ...",
  );
}
