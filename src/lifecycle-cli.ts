import { copyFile, mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { openAuthoritativeState } from "./authoritative-state/index.ts";
import { createLocalActivationEffects } from "./local-activation-effects.ts";
import {
  createLocalInstallation,
  localInstallationPaths,
  type LocalInstallation,
} from "./local-installation/index.ts";
import {
  connectLocalLeadHost,
  localLeadHostAddress,
  startLocalLeadHost,
  type LeadHostTranscriptEntry,
} from "./local-host/index.ts";
import { verifyLocalReleaseCandidate } from "./local-release/index.ts";
import { openRecoveryActor } from "./recovery-actor/index.ts";
import { requiredActivationHealthCriteria } from "./recovery-actor/index.ts";
import { createWindowsSupervision } from "./windows-supervision/index.ts";

const command = process.argv[2];

try {
  if (!command) throw usage();
  const installRoot = argumentValue("--install-root") ?? inferredInstallRoot();
  if (command === "supervise") await supervise(installRoot);
  else {
    const installation = await productionInstallation(installRoot, command === "install"
      ? requiredArgument("--actor-bundle")
      : undefined);
    if (command === "install") await install(installation, installRoot);
    else if (command === "start") await attach(await installation.start());
    else if (command === "stop") await installation.stop();
    else if (command === "inspect") process.stdout.write(`${JSON.stringify(await installation.inspect(), null, 2)}\n`);
    else if (command === "upgrade") await upgrade(installation);
    else if (command === "uninstall") await installation.uninstall();
    else throw usage();
  }
} catch (error) {
  process.stderr.write(
    `CMD_RIKER_LIFECYCLE_FAILURE: ${errorChain(error)}\n`,
  );
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

async function productionInstallation(
  installRoot: string,
  actorBundle?: string,
): Promise<LocalInstallation> {
  const actorCommand = actorBundle
    ? await commandFromCandidate(installRoot, actorBundle)
    : await commandFromLauncher(installRoot);
  const supervision = createWindowsSupervision({
    taskName: "\\CMD Riker\\Recovery Actor",
    currentUserId: currentUserId(),
    executable: actorCommand.runtimePath,
    arguments: `${quoteArgument(actorCommand.entrypointPath)} supervise --install-root ${quoteArgument(installRoot)}`,
    policy: { restartCount: 4, restartIntervalMinutes: 1 },
  });
  const paths = localInstallationPaths(installRoot);
  return createLocalInstallation({
    installationRoot: installRoot,
    supervision,
    activationEffects: createLocalActivationEffects({
      installationRoot: paths.root,
      stateDirectory: paths.state,
      recoveryDirectory: paths.recovery,
    }),
    connectHost: (address) => connectWithRetry(address, 10_000),
  });
}

async function install(installation: LocalInstallation, installRoot: string): Promise<void> {
  const paths = localInstallationPaths(installRoot);
  await mkdir(paths.state, { recursive: true });
  const config = argumentValue("--config");
  if (config) await copyFile(config, join(paths.state, "config.json"));
  const result = await installation.initialInstall({
    recoveryActorCandidateDirectory: requiredArgument("--actor-bundle"),
    leadAgentCandidateDirectory: requiredArgument("--lead-bundle"),
    stateRevision: argumentValue("--state-revision") ?? "initial-state",
    stateProvenance: "Owner-supplied initial local installation",
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function upgrade(installation: LocalInstallation): Promise<void> {
  const result = await installation.upgrade({
    leadAgentCandidateDirectory: requiredArgument("--lead-bundle"),
    stateRevision: requiredArgument("--state-revision"),
    stateProvenance: "Owner-supplied local upgrade",
    activation: {
      authority: { kind: "owner-supplied-upgrade", authorizedAt: new Date().toISOString() },
      compatibility: {
        stateSchema: "lossless-return-proven",
        evidence: requiredArgument("--compatibility-evidence"),
      },
      verification: {
        verdict: "passed",
        evidence: ["immutable bundle verified", "SQLite-native baseline verified"],
      },
      review: {
        verdict: "passed",
        evidence: [requiredArgument("--review-evidence")],
      },
      healthCriteria: [...requiredActivationHealthCriteria],
      budget: {
        deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
        probationChecks: 2,
      },
      recoveryPath: "restore-exact-baseline-pair",
    },
  });
  const client = await installation.start();
  await client.detach();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function supervise(installRoot: string): Promise<void> {
  let activeServer: Awaited<ReturnType<typeof startLocalLeadHost>> | undefined;
  let shutdownRequested = false;
  const gracefulShutdown = () => {
    shutdownRequested = true;
    void activeServer?.shutdown();
  };
  const shutdownSignals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;
  for (const signal of shutdownSignals) process.once(signal, gracefulShutdown);
  try {
    const installation = await productionInstallation(installRoot);
    let inspection = await installation.recover();
    while (inspection.currentOperation?.kind === "upgrade") {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      inspection = await installation.recover();
    }
    if (shutdownRequested) return;
    if (inspection.status !== "installed" || inspection.stopped || inspection.stopRequested) return;
    if (!inspection.actor) throw new Error("Protected Recovery Actor identity is unavailable.");
    const paths = localInstallationPaths(installRoot);
    const effects = createLocalActivationEffects({
      installationRoot: paths.root,
      stateDirectory: paths.state,
      recoveryDirectory: paths.recovery,
    });
    const actor = openRecoveryActor(paths.journal, inspection.actor, effects);
    try {
      await actor.recover();
      if (shutdownRequested) return;
      while (true) {
        const active = actor.inspect();
        if (!active.active || active.writeGeneration === undefined) {
          throw new Error("Recovery Actor has no exact accepted code-and-state pair.");
        }
        if (active.leadRestartBudget?.remaining === 0) {
          process.stderr.write(
            "CMD_RIKER_LEAD_RESTART_EXHAUSTED: The accepted Lead Agent revision requires Owner inspection.\n",
          );
          return;
        }
        const release = await verifyLocalReleaseCandidate(active.active.code.path, "lead-agent");
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
              String(active.writeGeneration),
              "--hosted",
            ],
            transcriptSeed: conversationSeed(paths.state, active.writeGeneration),
            durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
            ownerHandledMarker: "CMD_RIKER_OWNER_HANDLED",
            async onStopIntent() {
              const current = await installation.inspect();
              if (!current.stopRequested) {
                throw new Error("The durable whole-system stop intent is missing.");
              }
            },
          });
          activeServer = server;
          const exit = await server.exit;
          activeServer = undefined;
          if (exit.kind === "explicit-stop" || exit.kind === "graceful-shutdown") return;
          actor.recordLeadFailure(
            active.active.code.revision,
            `Lead Agent exited unexpectedly with code ${exit.code ?? "none"} and signal ${exit.signal ?? "none"}.`,
          );
        } catch (error) {
          actor.recordLeadFailure(
            active.active.code.revision,
            `Lead Agent launch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          activeServer = undefined;
        }
      }
    } finally {
      actor.close();
    }
  } finally {
    for (const signal of shutdownSignals) process.off(signal, gracefulShutdown);
  }
}

async function attach(client: Awaited<ReturnType<LocalInstallation["start"]>>): Promise<void> {
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

async function connectWithRetry(address: string, timeoutMs: number) {
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
  throw new Error("Timed out waiting for the protected Recovery Actor host.", { cause: lastError });
}

async function commandFromCandidate(installRoot: string, actorBundle: string) {
  const release = await verifyLocalReleaseCandidate(actorBundle, "recovery-actor");
  const destination = join(
    localInstallationPaths(installRoot).protectedRecoveryActorVersions,
    release.identity.revision,
  );
  return {
    runtimePath: join(destination, ...release.manifest.runtime.path.split("/")),
    entrypointPath: join(destination, ...release.manifest.entrypoint.split("/")),
  };
}

async function commandFromLauncher(installRoot: string) {
  const text = await readFile(
    join(localInstallationPaths(installRoot).launcher, "installation.json"),
    "utf8",
  );
  const value = JSON.parse(text) as {
    actor: { runtimePath: string; entrypointPath: string };
  };
  return value.actor;
}

function currentUserId(): string {
  const output = execFileSync(
    "whoami.exe",
    ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  const match = /,"(S-[0-9-]+)"$/.exec(output);
  if (!match?.[1]) throw new Error("Current Windows user SID is unavailable.");
  return match[1];
}

function quoteArgument(value: string): string {
  return `"${value.replaceAll(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.lastIndexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function inferredInstallRoot(): string {
  const entrypoint = fileURLToPath(import.meta.url);
  const inferred = resolve(dirname(entrypoint), "..", "..", "..", "..");
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
    "Usage: lifecycle-cli <install|start|stop|inspect|upgrade|uninstall|supervise> --install-root <path> ...",
  );
}
