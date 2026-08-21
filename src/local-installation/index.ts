import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  stageLocalRelease,
  verifyLocalReleaseCandidate,
  type VerifiedLocalRelease,
} from "../local-release/index.ts";
import {
  connectLocalLeadHost,
  localLeadHostAddress,
  type LocalLeadHostClient,
} from "../local-host/index.ts";
import {
  createAuthoritativeStateSnapshot,
  restoreAuthoritativeStateSnapshot,
  type AuthoritativeStateSnapshot,
} from "../state-snapshot/index.ts";
import {
  advanceWriteGeneration,
  ensureWriteGenerationSchema,
  readWriteGenerationHighWater,
} from "../write-generation.ts";
import { removeOwnerToastRegistration } from "../owner-notifications/index.ts";

export type CodeStatePair = {
  code: {
    revision: string;
    digest: string;
    path: string;
    runtime: { version: string; architecture: string };
  };
  state: {
    revision: string;
    digest: string;
    snapshotPath: string;
  };
};

export type LocalInstallationStatus = "not-installed" | "installed" | "uninstalled";

export type LocalInstallationPaths = {
  root: string;
  leadAgentVersions: string;
  launcher: string;
  state: string;
  recovery: string;
  snapshots: string;
  failedEvidence: string;
  journal: string;
  lifecycleJournal: string;
};

export type InitialInstallInput = {
  leadAgentCandidateDirectory: string;
  stateRevision: string;
  stateProvenance: string;
};

export type OwnerUpgradeInput = {
  leadAgentCandidateDirectory: string;
  stateRevision: string;
  stateProvenance: string;
};

export type LocalInstallationInspection = {
  status: LocalInstallationStatus;
  stopRequested: boolean;
  hostRunning: boolean;
  paths: LocalInstallationPaths;
  hostAddress: string;
  active?: CodeStatePair;
  previous?: CodeStatePair;
  currentOperation?: StoredLifecycle["operation"];
};

export type LocalInstallationOptions = {
  installationRoot: string;
  // The host runner is spawned detached from the active bundle; tests inject a fake.
  spawnHost?: (active: CodeStatePair, paths: LocalInstallationPaths) => Promise<void>;
  connectHost?: (address: string) => Promise<LocalLeadHostClient>;
  probeHost?: (address: string) => Promise<boolean>;
};

export interface LocalInstallation {
  initialInstall(input: InitialInstallInput): Promise<LocalInstallationInspection>;
  upgrade(input: OwnerUpgradeInput): Promise<{
    outcome: "activated";
    active: CodeStatePair;
    previous: CodeStatePair;
    snapshot: AuthoritativeStateSnapshot;
  }>;
  rollback(): Promise<{
    outcome: "rolled-back";
    active: CodeStatePair;
    restoredWriteGeneration: number;
  }>;
  inspect(): Promise<LocalInstallationInspection>;
  start(): Promise<LocalLeadHostClient>;
  stop(): Promise<void>;
  uninstall(): Promise<void>;
}

type StoredLifecycle = {
  status: Exclude<LocalInstallationStatus, "not-installed">;
  stopRequested: boolean;
  active: CodeStatePair;
  previous?: CodeStatePair;
  operation?: {
    id: string;
    kind: LifecycleOperation;
    pid: number;
    startedAt: string;
  };
};

type LifecycleOperation = "install" | "start" | "stop" | "upgrade" | "rollback" | "uninstall";

type ClaimedLifecycle = StoredLifecycle & {
  operation: NonNullable<StoredLifecycle["operation"]>;
};

export class LocalInstallationError extends Error {
  readonly operation: LifecycleOperation | "inspect";

  constructor(operation: LifecycleOperation | "inspect", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LocalInstallationError";
    this.operation = operation;
  }
}

export function localInstallationPaths(installationRoot: string): LocalInstallationPaths {
  const root = resolve(installationRoot);
  const recovery = join(root, "recovery");
  const journal = join(recovery, "journal");
  return {
    root,
    leadAgentVersions: join(root, "versions"),
    launcher: join(root, "launcher"),
    state: join(root, "state"),
    recovery,
    snapshots: join(recovery, "snapshots"),
    failedEvidence: join(recovery, "failed-evidence"),
    journal,
    lifecycleJournal: join(journal, "installation-lifecycle.sqlite"),
  };
}

export function createLocalInstallation(options: LocalInstallationOptions): LocalInstallation {
  const paths = localInstallationPaths(options.installationRoot);
  const hostAddress = localLeadHostAddress(paths.root);
  // The host verifies its bundle (hashing every file) before the pipe listens,
  // so a fresh start needs well over ten seconds on a real bundle.
  const connectHost = options.connectHost ?? ((address) => connectWithRetry(address, 60_000));
  const probeHost = options.probeHost ?? (async (address) => {
    try {
      const client = await connectLocalLeadHost(address);
      await client.detach();
      return true;
    } catch {
      return false;
    }
  });
  // Start-Process launches the host without inheriting any handle from this
  // process chain. A plain detached spawn silently inherits the caller's
  // inheritable stdout pipe on Windows, so `riker upgrade` would never see EOF
  // and hang in the Owner's terminal until the host exits.
  const spawnHost = options.spawnHost ?? (async (active) => {
    const release = await verifyLocalReleaseCandidate(active.code.path, "lead-agent");
    const lifecyclePath = join(active.code.path, "dist", "lifecycle-cli.js");
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Start-Process -FilePath '${release.runtime.path}' ` +
            `-ArgumentList @('"${lifecyclePath}"','host','--install-root','"${paths.root}"') ` +
            "-WindowStyle Hidden",
        ],
        { stdio: "ignore", windowsHide: true },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolvePromise()
          : reject(new Error(`The host launcher exited with code ${code ?? "none"}.`)),
      );
    });
  });

  const inspect = async (): Promise<LocalInstallationInspection> => {
    try {
      const lifecycle = readLifecycle(paths.lifecycleJournal);
      if (!lifecycle) {
        return {
          status: "not-installed",
          stopRequested: false,
          hostRunning: false,
          paths,
          hostAddress,
        };
      }
      return {
        status: lifecycle.status,
        stopRequested: lifecycle.stopRequested,
        hostRunning: lifecycle.status === "installed" && await probeHost(hostAddress),
        ...(lifecycle.operation ? { currentOperation: lifecycle.operation } : {}),
        paths,
        hostAddress,
        active: lifecycle.active,
        ...(lifecycle.previous ? { previous: lifecycle.previous } : {}),
      };
    } catch (error) {
      if (error instanceof LocalInstallationError) throw error;
      throw new LocalInstallationError("inspect", "Local installation inspection failed.", error);
    }
  };

  const connectForStop = options.connectHost ??
    (async (address: string) => connectLocalLeadHost(address));
  const stopHost = async (lifecycle: StoredLifecycle): Promise<void> => {
    writeLifecycle(paths.lifecycleJournal, { ...lifecycle, stopRequested: true });
    try {
      const client = await connectForStop(hostAddress);
      await client.stop();
    } catch {
      // No reachable host means it is already down; the durable stop intent
      // keeps the host runner from restarting a straggler.
    }
    await hostGone(probeHost, hostAddress, 10_000);
  };

  const startHost = async (lifecycle: StoredLifecycle): Promise<LocalLeadHostClient> => {
    writeLifecycle(paths.lifecycleJournal, { ...lifecycle, stopRequested: false });
    if (!(await probeHost(hostAddress))) {
      await spawnHost(lifecycle.active, paths);
    }
    return connectHost(hostAddress);
  };

  const withOperation = async <T>(
    kind: LifecycleOperation,
    operation: (lifecycle: ClaimedLifecycle) => Promise<T>,
  ): Promise<T> => {
    releaseAbandonedOperation(paths.lifecycleJournal);
    const lifecycle = claimLifecycleOperation(paths.lifecycleJournal, kind);
    try {
      return await operation(lifecycle);
    } catch (error) {
      if (error instanceof LocalInstallationError) throw error;
      throw new LocalInstallationError(
        kind,
        `Local installation ${kind} failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      releaseLifecycleOperation(paths.lifecycleJournal, lifecycle.operation.id);
    }
  };

  return {
    async initialInstall(input) {
      try {
        const existing = readLifecycle(paths.lifecycleJournal);
        if (existing?.status === "installed") {
          throw new Error("Local installation is already installed.");
        }
        const release = await stageLocalRelease(
          input.leadAgentCandidateDirectory,
          paths.leadAgentVersions,
          "lead-agent",
        );
        await mkdir(paths.state, { recursive: true });
        await mkdir(paths.snapshots, { recursive: true });
        await mkdir(paths.failedEvidence, { recursive: true });
        await mkdir(paths.journal, { recursive: true });
        ensureInitialState(paths.state);
        const snapshot = await createAuthoritativeStateSnapshot({
          stateDirectory: paths.state,
          recoveryDirectory: paths.snapshots,
          revision: input.stateRevision,
          provenance: input.stateProvenance,
        });
        const active = releaseStatePair(release, snapshot);
        writeLifecycle(paths.lifecycleJournal, {
          status: "installed",
          stopRequested: true,
          active,
        });
        await writeLauncherManifest(paths, hostAddress, release);
        return await inspect();
      } catch (error) {
        if (error instanceof LocalInstallationError) throw error;
        throw new LocalInstallationError(
          "install",
          `Local installation failed: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    },

    async upgrade(input) {
      return withOperation("upgrade", async (lifecycle) => {
        const release = await stageLocalRelease(
          input.leadAgentCandidateDirectory,
          paths.leadAgentVersions,
          "lead-agent",
        );
        await stopHost(lifecycle);
        const snapshot = await createAuthoritativeStateSnapshot({
          stateDirectory: paths.state,
          recoveryDirectory: paths.snapshots,
          revision: input.stateRevision,
          provenance: input.stateProvenance,
        });
        // Advancing the generation fences any straggler host of the old version.
        advanceWriteGeneration(paths.state, snapshot.writeGeneration);
        const active = releaseStatePair(release, snapshot);
        // Rollback returns to the previous code with the state as it was right
        // before this cutover, so the pair shares the fresh snapshot.
        const previous: CodeStatePair = { code: lifecycle.active.code, state: active.state };
        const updated: StoredLifecycle = {
          status: "installed",
          stopRequested: true,
          active,
          previous,
          operation: lifecycle.operation,
        };
        writeLifecycle(paths.lifecycleJournal, updated);
        await writeLauncherManifest(paths, hostAddress, release);
        return {
          outcome: "activated" as const,
          active,
          previous,
          snapshot,
        };
      });
    },

    async rollback() {
      return withOperation("rollback", async (lifecycle) => {
        const previous = lifecycle.previous;
        if (!previous) throw new Error("No previous version is available to roll back to.");
        await verifyLocalReleaseCandidate(previous.code.path, "lead-agent");
        await stopHost(lifecycle);
        const failedGeneration = readGeneration(paths.state);
        const freshWriteGeneration = Math.max(
          failedGeneration,
          readWriteGenerationHighWater(paths.state) ?? 0,
        ) + 1;
        const evidenceDirectory = join(
          paths.failedEvidence,
          `generation-${failedGeneration}-${previous.state.digest.slice(0, 16)}`,
        );
        await mkdir(evidenceDirectory, { recursive: true });
        await restoreAuthoritativeStateSnapshot({
          stateDirectory: paths.state,
          evidenceDirectory,
          snapshot: {
            revision: previous.state.revision,
            digest: previous.state.digest,
            path: previous.state.snapshotPath,
            writeGeneration: readSnapshotGeneration(previous.state.snapshotPath),
            provenance: `Rollback to ${previous.code.revision}`,
          },
          expectedDigest: previous.state.digest,
          failedWriteGeneration: failedGeneration,
          freshWriteGeneration,
        });
        const updated: StoredLifecycle = {
          status: "installed",
          stopRequested: true,
          active: previous,
          previous: lifecycle.active,
          operation: lifecycle.operation,
        };
        writeLifecycle(paths.lifecycleJournal, updated);
        const release = await verifyLocalReleaseCandidate(previous.code.path, "lead-agent");
        await writeLauncherManifest(paths, hostAddress, release);
        return {
          outcome: "rolled-back" as const,
          active: previous,
          restoredWriteGeneration: freshWriteGeneration,
        };
      });
    },

    inspect,

    async start() {
      return withOperation("start", (lifecycle) => startHost(lifecycle));
    },

    async stop() {
      return withOperation("stop", (lifecycle) => stopHost(lifecycle));
    },

    async uninstall() {
      return withOperation("uninstall", async (lifecycle) => {
        await stopHost(lifecycle);
        await rm(paths.leadAgentVersions, { recursive: true, force: true });
        await rm(paths.launcher, { recursive: true, force: true });
        await rm(join(paths.root, "protected"), { recursive: true, force: true });
        // The toast identity shortcut is launcher material and leaves with it.
        await removeOwnerToastRegistration();
        writeLifecycle(paths.lifecycleJournal, {
          ...lifecycle,
          status: "uninstalled",
          stopRequested: true,
        });
      });
    },
  };
}

export async function connectWithRetry(
  address: string,
  timeoutMs: number,
): Promise<LocalLeadHostClient> {
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
  throw new Error("Timed out waiting for the Lead Agent host.", { cause: lastError });
}

async function hostGone(
  probeHost: (address: string) => Promise<boolean>,
  address: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeHost(address))) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("The Lead Agent host did not release its address after the stop request.");
}

function releaseStatePair(
  release: VerifiedLocalRelease,
  snapshot: AuthoritativeStateSnapshot,
): CodeStatePair {
  return {
    code: {
      revision: release.identity.revision,
      digest: release.identity.digest,
      path: release.path,
      runtime: {
        version: release.runtime.version,
        architecture: release.runtime.architecture,
      },
    },
    state: {
      revision: snapshot.revision,
      digest: snapshot.digest,
      snapshotPath: snapshot.path,
    },
  };
}

function ensureInitialState(stateDirectory: string): void {
  const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"));
  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    ensureWriteGenerationSchema(database);
  } finally {
    database.close();
  }
}

export function readGeneration(stateDirectory: string): number {
  const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"), {
    readOnly: true,
  });
  try {
    return (database
      .prepare("SELECT write_generation FROM lifecycle_metadata WHERE singleton = 1")
      .get() as { write_generation: number }).write_generation;
  } finally {
    database.close();
  }
}

function readSnapshotGeneration(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (database
      .prepare("SELECT write_generation FROM lifecycle_metadata WHERE singleton = 1")
      .get() as { write_generation: number }).write_generation;
  } finally {
    database.close();
  }
}

async function writeLauncherManifest(
  paths: LocalInstallationPaths,
  hostAddress: string,
  leadAgent: VerifiedLocalRelease,
): Promise<void> {
  await mkdir(paths.launcher, { recursive: true });
  for (const required of ["dist/owner-launcher.js", "dist/owner-client.js", "dist/lifecycle-cli.js"]) {
    if (!leadAgent.manifest.files.some((file) => file.path === required)) {
      throw new Error(`The Lead Agent release does not contain ${required}.`);
    }
  }
  await writeFile(
    join(paths.launcher, "installation.json"),
    `${JSON.stringify({
      formatVersion: 2,
      hostAddress,
      leadAgent: {
        identity: leadAgent.identity,
        path: leadAgent.path,
        entrypointPath: leadAgent.entrypointPath,
        runtimePath: leadAgent.runtime.path,
        lifecyclePath: join(leadAgent.path, "dist", "lifecycle-cli.js"),
        ownerClientPath: join(leadAgent.path, "dist", "owner-client.js"),
      },
      stateDirectory: paths.state,
      recoveryDirectory: paths.recovery,
      journalDirectory: paths.journal,
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(paths.launcher, "riker.cmd"),
    `@echo off\r\n"${leadAgent.runtime.path}" "${join(leadAgent.path, "dist", "owner-launcher.js")}" --install-root "${paths.root}" %*\r\n`,
    "utf8",
  );
}

export function readLifecycle(path: string): StoredLifecycle | undefined {
  if (!existsSync(path)) return undefined;
  const database = openLifecycleDatabase(path);
  try {
    return readLifecycleRow(database);
  } finally {
    database.close();
  }
}

function readLifecycleRow(database: DatabaseSync): StoredLifecycle | undefined {
  const row = database
    .prepare(`
      SELECT status, stop_requested, active_json, previous_json, operation_json
        FROM local_lifecycle_v2
       WHERE singleton = 1
    `)
    .get() as {
      status: StoredLifecycle["status"];
      stop_requested: number;
      active_json: string;
      previous_json: string | null;
      operation_json: string | null;
    } | undefined;
  return row
    ? {
        status: row.status,
        stopRequested: row.stop_requested === 1,
        active: JSON.parse(row.active_json) as CodeStatePair,
        ...(row.previous_json
          ? { previous: JSON.parse(row.previous_json) as CodeStatePair }
          : {}),
        ...(row.operation_json
          ? { operation: JSON.parse(row.operation_json) as NonNullable<StoredLifecycle["operation"]> }
          : {}),
      }
    : undefined;
}

function writeLifecycle(path: string, lifecycle: StoredLifecycle): void {
  const database = openLifecycleDatabase(path);
  try {
    database
      .prepare(`
        INSERT INTO local_lifecycle_v2 (
          singleton, status, stop_requested, active_json, previous_json, operation_json, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          status = excluded.status,
          stop_requested = excluded.stop_requested,
          active_json = excluded.active_json,
          previous_json = excluded.previous_json,
          operation_json = excluded.operation_json,
          updated_at = excluded.updated_at
      `)
      .run(
        lifecycle.status,
        lifecycle.stopRequested ? 1 : 0,
        JSON.stringify(lifecycle.active),
        lifecycle.previous ? JSON.stringify(lifecycle.previous) : null,
        lifecycle.operation ? JSON.stringify(lifecycle.operation) : null,
        new Date().toISOString(),
      );
  } finally {
    database.close();
  }
}

function openLifecycleDatabase(path: string): DatabaseSync {
  const directory = dirname(path);
  // DatabaseSync cannot create its parent directory.
  if (!existsSync(directory)) throw new Error("Local installation journal directory is missing.");
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS local_lifecycle_v2 (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      status TEXT NOT NULL CHECK (status IN ('installed', 'uninstalled')),
      stop_requested INTEGER NOT NULL CHECK (stop_requested IN (0, 1)),
      active_json TEXT NOT NULL CHECK (json_valid(active_json)),
      previous_json TEXT CHECK (previous_json IS NULL OR json_valid(previous_json)),
      operation_json TEXT CHECK (operation_json IS NULL OR json_valid(operation_json)),
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  return database;
}

function claimLifecycleOperation(path: string, kind: LifecycleOperation): ClaimedLifecycle {
  const database = openLifecycleDatabase(path);
  database.exec("BEGIN IMMEDIATE");
  try {
    const lifecycle = readLifecycleRow(database);
    if (!lifecycle || lifecycle.status !== "installed") {
      throw new Error("Local installation is not installed.");
    }
    if (lifecycle.operation) {
      throw new Error(
        `Local installation operation ${lifecycle.operation.kind} is already in progress.`,
      );
    }
    const operation = {
      id: randomUUID(),
      kind,
      pid: process.pid,
      startedAt: processStartedAt(process.pid) ?? new Date().toISOString(),
    };
    database
      .prepare("UPDATE local_lifecycle_v2 SET operation_json = ?, updated_at = ? WHERE singleton = 1")
      .run(JSON.stringify(operation), new Date().toISOString());
    database.exec("COMMIT");
    return { ...lifecycle, operation };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function releaseLifecycleOperation(path: string, operationId: string): void {
  const database = openLifecycleDatabase(path);
  try {
    const row = database
      .prepare("SELECT operation_json FROM local_lifecycle_v2 WHERE singleton = 1")
      .get() as { operation_json: string | null } | undefined;
    if (!row?.operation_json) return;
    const operation = JSON.parse(row.operation_json) as NonNullable<StoredLifecycle["operation"]>;
    if (operation.id !== operationId) return;
    database
      .prepare(`
        UPDATE local_lifecycle_v2
           SET operation_json = NULL, updated_at = ?
         WHERE singleton = 1 AND operation_json = ?
      `)
      .run(new Date().toISOString(), row.operation_json);
  } finally {
    database.close();
  }
}

function releaseAbandonedOperation(path: string): void {
  const lifecycle = readLifecycle(path);
  const operation = lifecycle?.operation;
  if (!operation || processMatches(operation.pid, operation.startedAt)) return;
  releaseLifecycleOperation(path, operation.id);
}

function processMatches(pid: number, startedAt: string): boolean {
  return processStartedAt(pid) === startedAt;
}

function processStartedAt(pid: number): string | undefined {
  try {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    return undefined;
  }
}
