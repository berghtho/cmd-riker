import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { openAuthoritativeState } from "./authoritative-state/index.ts";
import {
  createLocalInstallation,
  localInstallationPaths,
  nextRevision,
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
import { createWindowsToastNotifier } from "./owner-notifications/index.ts";

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
    const supplied = argumentValue("--lead-bundle");
    const built = supplied === undefined
      ? await buildFromSourceRepository(installation)
      : undefined;
    const leadAgentCandidateDirectory = supplied ?? built!.bundleDirectory;
    const stateRevision = argumentValue("--state-revision") ??
      (built ? `before-${built.revision}` : `before-upgrade-${Date.now()}`);
    const result = await installation.upgrade({
      leadAgentCandidateDirectory,
      stateRevision,
      stateProvenance: "Owner-supplied local upgrade",
    });
    await recordSourceRepository(installRoot, result.active.code.path);
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

// A bare `riker upgrade` builds the next revision from the source repository
// the installed bundle recorded, so the update notice's instruction is one
// literal command. Bundles built without a source record fall back to the
// installation-level record written on the last successful install/upgrade.
async function buildFromSourceRepository(
  installation: LocalInstallation,
): Promise<{ bundleDirectory: string; revision: string }> {
  const inspection = await installation.inspect();
  const active = inspection.active;
  if (!active) throw new Error("No installed version to upgrade from; supply --lead-bundle.");
  const recorded = [
    await readSourceRepositoryPath(join(active.code.path, "source.json")),
    await readSourceRepositoryPath(sourceRepositoryRecordPath(inspection.paths.root)),
  ].filter((path): path is string => path !== undefined);
  if (recorded.length === 0) {
    throw new Error(
      "Neither the installed bundle nor the installation records a source repository; " +
        "supply --lead-bundle explicitly.",
    );
  }
  const repositoryPath = recorded.find((path) => existsSync(path));
  if (!repositoryPath) {
    throw new Error(
      "The recorded source repository is unavailable; supply --lead-bundle explicitly.",
    );
  }
  const buildScript = join(repositoryPath, "scripts", "build-release.ps1");
  if (!existsSync(buildScript)) {
    throw new Error(`The source repository is missing ${buildScript}; supply --lead-bundle.`);
  }
  let revision = nextRevision(active.code.revision);
  while (existsSync(join(repositoryPath, "release", revision))) {
    revision = nextRevision(revision);
  }
  process.stdout.write(`Building ${revision} from ${repositoryPath} …\n`);
  await runBuild(buildScript, revision);
  const bundleDirectory = join(repositoryPath, "release", revision, "lead-agent");
  if (!existsSync(join(bundleDirectory, "manifest.json"))) {
    throw new Error(`The build did not produce ${bundleDirectory}.`);
  }
  return { bundleDirectory, revision };
}

function sourceRepositoryRecordPath(installRoot: string): string {
  return join(localInstallationPaths(installRoot).state, "source-repository.json");
}

async function readSourceRepositoryPath(file: string): Promise<string | undefined> {
  try {
    const record = JSON.parse(await readFile(file, "utf8")) as { repositoryPath?: string };
    return typeof record.repositoryPath === "string" ? record.repositoryPath : undefined;
  } catch {
    return undefined;
  }
}

// Mirrors the activated bundle's source record at installation level so a later
// bare `riker upgrade` survives a bundle that was built without one.
async function recordSourceRepository(installRoot: string, bundlePath: string): Promise<void> {
  const repositoryPath = await readSourceRepositoryPath(join(bundlePath, "source.json"));
  if (repositoryPath === undefined) return;
  await writeFile(
    sourceRepositoryRecordPath(installRoot),
    `${JSON.stringify({ formatVersion: 1, repositoryPath }, null, 2)}\n`,
    "utf8",
  );
}

function runBuild(buildScript: string, revision: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", buildScript, "-Revision", revision],
      { stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`The release build exited with code ${code ?? "none"}.`)),
    );
  });
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
  if (result.active) await recordSourceRepository(installRoot, result.active.code.path);
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
      // A bundle without the vendored SnoreToast simply runs without toasts.
      const toastExecutable = join(release.path, "tools", "snoretoast", "snoretoast-x64.exe");
      const toasts = existsSync(toastExecutable)
        ? createWindowsToastNotifier({ snoretoastPath: toastExecutable })
        : undefined;
      if (toasts) await toasts.ensureRegistered().catch(() => {});
      const workerNoticePrefix = "CMD_RIKER_WORKER_NOTICE: ";
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
          onTranscriptEntry(entry) {
            if (!toasts || entry.source !== "lead" || entry.stream !== "stdout") return;
            if (!entry.line.startsWith(workerNoticePrefix)) return;
            toasts.notify({
              title: "CMD Riker",
              message: entry.line.slice(workerNoticePrefix.length),
            });
          },
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
    // A restarted host replays the session the Owner spoke to last.
    return (state.readOwnerConversation(state.latestActiveOwnerSessionId())?.messages ?? []).map((message) =>
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
  else if (entry.line.startsWith("CMD_RIKER_SESSION_JSON:")) return;
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
