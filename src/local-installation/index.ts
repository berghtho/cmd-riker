import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
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
  openRecoveryActor,
  type ActivationEffects,
  type CodeStatePair,
  type RecoveryActor,
  type RecoveryActorIdentity,
} from "../recovery-actor/index.ts";
import {
  createAuthoritativeStateSnapshot,
  type AuthoritativeStateSnapshot,
} from "../state-snapshot/index.ts";
import type {
  WindowsSupervisionInspection,
  WindowsTaskSchedulerSupervision,
} from "../windows-supervision/index.ts";
import { ensureWriteGenerationSchema } from "../write-generation.ts";

export type LocalInstallationStatus =
  | "not-installed"
  | "prepared"
  | "installed"
  | "registration-failed"
  | "uninstalled";

export type LocalInstallationPaths = {
  root: string;
  leadAgentVersions: string;
  protectedRecoveryActorVersions: string;
  launcher: string;
  state: string;
  recovery: string;
  snapshots: string;
  failedEvidence: string;
  journal: string;
  activationJournal: string;
  lifecycleJournal: string;
};

export type LocalInstallationSupervision = Pick<
  WindowsTaskSchedulerSupervision,
  "register" | "verify" | "inspect" | "start" | "stop" | "unregister"
>;

export type InitialInstallInput = {
  recoveryActorCandidateDirectory: string;
  leadAgentCandidateDirectory: string;
  stateRevision: string;
  stateProvenance: string;
};

type RecoveryActivationInput = Parameters<RecoveryActor["activate"]>[0];

export type OwnerUpgradeInput = {
  leadAgentCandidateDirectory: string;
  stateRevision: string;
  stateProvenance: string;
  activation: Omit<RecoveryActivationInput, "candidate" | "baseline">;
};

export type LocalInstallationInspection = {
  status: LocalInstallationStatus;
  stopRequested: boolean;
  stopped: boolean;
  paths: LocalInstallationPaths;
  hostAddress: string;
  actor?: RecoveryActorIdentity;
  active?: CodeStatePair;
  recoveryBaseline?: CodeStatePair;
  writeGeneration?: number;
  currentAttempt?: ReturnType<RecoveryActor["inspect"]>["currentAttempt"];
  leadRestartBudget?: ReturnType<RecoveryActor["inspect"]>["leadRestartBudget"];
  currentOperation?: StoredLifecycle["operation"];
  supervision?: WindowsSupervisionInspection;
};

export type LocalInstallationOptions = {
  installationRoot: string;
  supervision: LocalInstallationSupervision;
  activationEffects: ActivationEffects;
  connectHost?: (address: string) => Promise<LocalLeadHostClient>;
  requestStop?: (address: string) => Promise<void>;
};

export interface LocalInstallation {
  initialInstall(input: InitialInstallInput): Promise<LocalInstallationInspection>;
  upgrade(input: OwnerUpgradeInput): Promise<{
    attemptId: string;
    outcome: "activated" | "rolled-back";
    candidate: CodeStatePair;
    snapshot: AuthoritativeStateSnapshot;
  }>;
  recover(): Promise<LocalInstallationInspection>;
  inspect(): Promise<LocalInstallationInspection>;
  start(): Promise<LocalLeadHostClient>;
  stop(): Promise<void>;
  uninstall(): Promise<void>;
}

type StoredLifecycle = {
  status: Exclude<LocalInstallationStatus, "not-installed">;
  stopRequested: boolean;
  stopped: boolean;
  actor: RecoveryActorIdentity;
  operation?: {
    id: string;
    kind: Exclude<LifecycleOperation, "install" | "inspect">;
    pid: number;
    startedAt: string;
  };
};

type LifecycleOperation = "install" | "inspect" | "start" | "stop" | "upgrade" | "uninstall";

export class LocalInstallationError extends Error {
  readonly operation: LifecycleOperation;

  constructor(operation: LifecycleOperation, message: string, cause?: unknown) {
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
    protectedRecoveryActorVersions: join(root, "protected", "recovery-actor"),
    launcher: join(root, "launcher"),
    state: join(root, "state"),
    recovery,
    snapshots: join(recovery, "snapshots"),
    failedEvidence: join(recovery, "failed-evidence"),
    journal,
    activationJournal: join(journal, "activation-journal.sqlite"),
    lifecycleJournal: join(journal, "installation-lifecycle.sqlite"),
  };
}

export function createLocalInstallation(options: LocalInstallationOptions): LocalInstallation {
  const paths = localInstallationPaths(options.installationRoot);
  const hostAddress = localLeadHostAddress(paths.root);
  const connectHost = options.connectHost ?? connectLocalLeadHost;

  const withActor = async <T>(
    identity: RecoveryActorIdentity,
    operation: (actor: RecoveryActor) => Promise<T> | T,
  ): Promise<T> => {
    const actor = openRecoveryActor(paths.journal, identity, options.activationEffects);
    try {
      return await operation(actor);
    } finally {
      actor.close();
    }
  };

  const requireInstalled = (): StoredLifecycle => {
    const lifecycle = readLifecycle(paths.lifecycleJournal);
    if (lifecycle?.status !== "installed") {
      throw new Error("Local installation is not installed.");
    }
    return lifecycle;
  };

  const inspect = async (): Promise<LocalInstallationInspection> => {
    try {
      const lifecycle = readLifecycle(paths.lifecycleJournal);
      if (!lifecycle) {
        return {
          status: "not-installed",
          stopRequested: false,
          stopped: false,
          paths,
          hostAddress,
        };
      }
      const actorInspection = await withActor(lifecycle.actor, (actor) => actor.inspect());
      const supervision = lifecycle.status === "installed"
        ? await options.supervision.inspect()
        : undefined;
      return {
        status: lifecycle.status,
        stopRequested: lifecycle.stopRequested,
        stopped: lifecycle.stopped,
        ...(lifecycle.operation ? { currentOperation: lifecycle.operation } : {}),
        paths,
        hostAddress,
        ...actorInspection,
        ...(supervision ? { supervision } : {}),
      };
    } catch (error) {
      if (error instanceof LocalInstallationError) throw error;
      throw new LocalInstallationError("inspect", "Local installation inspection failed.", error);
    }
  };

  const stopInstalledLifecycle = async (lifecycle: StoredLifecycle): Promise<void> => {
    if (lifecycle.stopped) return;
    if (!lifecycle.stopRequested) {
      writeLifecycle(paths.lifecycleJournal, {
        ...lifecycle,
        stopRequested: true,
        stopped: false,
      });
      try {
        if (options.requestStop) {
          await options.requestStop(hostAddress);
        } else {
          const client = await connectHost(hostAddress);
          await client.stop();
        }
      } catch {
        // The durable stop intent remains authoritative; scheduler termination still fences restarts.
      }
    }
    await options.supervision.stop();
    writeLifecycle(paths.lifecycleJournal, {
      ...lifecycle,
      stopRequested: true,
      stopped: true,
    });
  };

  const stop = async (): Promise<void> => {
    let operation: StoredLifecycle["operation"];
    try {
      const lifecycle = claimLifecycleOperation(paths.lifecycleJournal, "stop");
      operation = lifecycle.operation;
      await stopInstalledLifecycle(lifecycle);
    } catch (error) {
      if (error instanceof LocalInstallationError) throw error;
      throw new LocalInstallationError(
        "stop",
        "Local installation stop failed before scheduler shutdown completed.",
        error,
      );
    } finally {
      if (operation) releaseLifecycleOperation(paths.lifecycleJournal, operation.id);
    }
  };

  return {
    async initialInstall(input) {
      let existing: StoredLifecycle | undefined;
      try {
        existing = readLifecycle(paths.lifecycleJournal);
      } catch (error) {
        throw new LocalInstallationError(
          "install",
          "Local installation lifecycle journal could not be read.",
          error,
        );
      }
      if (existing?.status === "installed") {
        throw new LocalInstallationError("install", "Local installation is already installed.");
      }

      try {
        const actorRelease = await stageLocalRelease(
          input.recoveryActorCandidateDirectory,
          paths.protectedRecoveryActorVersions,
          "recovery-actor",
        );
        const leadRelease = await stageLocalRelease(
          input.leadAgentCandidateDirectory,
          paths.leadAgentVersions,
          "lead-agent",
        );
        const actorIdentity = releaseActorIdentity(actorRelease);

        await mkdir(paths.state, { recursive: true });
        await mkdir(paths.snapshots, { recursive: true });
        await mkdir(paths.failedEvidence, { recursive: true });
        ensureInitialState(paths.state);

        await withActor(actorIdentity, async (actor) => {
          const initialized = actor.inspect();
          if (initialized.actor) {
            requireSameInitialIdentity(initialized, actorIdentity, leadRelease, input.stateRevision);
            return;
          }
          const snapshot = await createAuthoritativeStateSnapshot({
            stateDirectory: paths.state,
            recoveryDirectory: paths.snapshots,
            revision: input.stateRevision,
            provenance: input.stateProvenance,
          });
          const initialPair = releaseStatePair(leadRelease, snapshot);
          actor.initialize({
            active: initialPair,
            recoveryBaseline: initialPair,
            writeGeneration: snapshot.writeGeneration,
          });
        });

        writeLifecycle(paths.lifecycleJournal, {
          status: "prepared",
          stopRequested: false,
          stopped: true,
          actor: actorIdentity,
        });
        await writeLauncherManifest(paths, hostAddress, actorRelease, leadRelease);
      } catch (error) {
        if (error instanceof LocalInstallationError) throw error;
        throw new LocalInstallationError("install", "Local installation preparation failed.", error);
      }

      const prepared = readLifecycle(paths.lifecycleJournal);
      if (!prepared) {
        throw new LocalInstallationError("install", "Local installation preparation was not recorded.");
      }
      try {
        await options.supervision.register();
        await options.supervision.verify();
        writeLifecycle(paths.lifecycleJournal, {
          ...prepared,
          status: "installed",
          stopRequested: false,
          stopped: true,
        });
      } catch (registrationError) {
        let rollbackError: unknown;
        try {
          await options.supervision.unregister();
        } catch (error) {
          rollbackError = error;
        }
        writeLifecycle(paths.lifecycleJournal, {
          ...prepared,
          status: "registration-failed",
          stopRequested: true,
          stopped: rollbackError === undefined,
        });
        const cause = rollbackError === undefined
          ? registrationError
          : new AggregateError(
              [registrationError, rollbackError],
              "Scheduler registration and rollback both failed.",
            );
        throw new LocalInstallationError(
          "install",
          "Local installation scheduler registration failed and was rolled back.",
          cause,
        );
      }
      return inspect();
    },

    async upgrade(input) {
      let operation: StoredLifecycle["operation"];
      let stoppedForUpgrade = false;
      let snapshot: AuthoritativeStateSnapshot | undefined;
      let candidate: CodeStatePair | undefined;
      try {
        const lifecycle = claimLifecycleOperation(paths.lifecycleJournal, "upgrade");
        operation = lifecycle.operation;
        const release = await stageLocalRelease(
          input.leadAgentCandidateDirectory,
          paths.leadAgentVersions,
          "lead-agent",
        );
        if (resolve(release.path) === resolve(lifecycle.actor.path)) {
          throw new Error("An Owner-supplied candidate cannot target the protected Recovery Actor.");
        }
        const result = await withActor(lifecycle.actor, async (actor) => {
          const current = actor.inspect();
          if (!current.active || !current.recoveryBaseline || current.writeGeneration === undefined) {
            throw new Error("Recovery Actor has no exact active code-and-state identity.");
          }
          const wasRunning = !lifecycle.stopped;
          await stopInstalledLifecycle(lifecycle);
          stoppedForUpgrade = wasRunning;
          snapshot = await createAuthoritativeStateSnapshot({
            stateDirectory: paths.state,
            recoveryDirectory: paths.snapshots,
            revision: input.stateRevision,
            provenance: input.stateProvenance,
          });
          candidate = releaseStatePair(release, snapshot);
          if (snapshot.writeGeneration !== current.writeGeneration) {
            throw new Error(
              "Owner upgrade snapshot write generation does not match the active Recovery Actor generation.",
            );
          }
          const baseline: CodeStatePair = {
            code: current.recoveryBaseline.code,
            state: candidate.state,
          };
          writeLifecycle(paths.lifecycleJournal, {
            ...lifecycle,
            stopRequested: false,
            stopped: false,
          });
          await options.supervision.start();
          stoppedForUpgrade = false;
          return actor.activate({ ...input.activation, candidate, baseline });
        });
        if (!candidate || !snapshot) throw new Error("Owner upgrade did not establish its exact candidate pair.");
        if (result.outcome === "activated") {
          const actorRelease = await verifyLocalReleaseCandidate(
            lifecycle.actor.path,
            "recovery-actor",
          );
          await writeLauncherManifest(paths, hostAddress, actorRelease, release);
        }
        return { ...result, candidate, snapshot };
      } catch (error) {
        if (stoppedForUpgrade) {
          const current = readLifecycle(paths.lifecycleJournal);
          if (current?.status === "installed") {
            writeLifecycle(paths.lifecycleJournal, {
              ...current,
              stopRequested: false,
              stopped: false,
            });
            await options.supervision.start();
          }
        }
        if (error instanceof LocalInstallationError) throw error;
        throw new LocalInstallationError("upgrade", "Owner-supplied upgrade failed.", error);
      } finally {
        if (operation) releaseLifecycleOperation(paths.lifecycleJournal, operation.id);
      }
    },

    async recover() {
      try {
        const lifecycle = requireInstalled();
        if (!lifecycle.operation) return inspect();
        if (lifecycle.operation.kind === "upgrade") {
          if (processMatches(lifecycle.operation.pid, lifecycle.operation.startedAt)) {
            return inspect();
          }
          await withActor(lifecycle.actor, (actor) => actor.recover());
          releaseLifecycleOperation(paths.lifecycleJournal, lifecycle.operation.id);
        } else if (lifecycle.operation.kind === "start") {
          releaseLifecycleOperation(paths.lifecycleJournal, lifecycle.operation.id);
        } else if (lifecycle.operation.kind === "stop" && lifecycle.stopped) {
          releaseLifecycleOperation(paths.lifecycleJournal, lifecycle.operation.id);
        }
        return inspect();
      } catch (error) {
        throw new LocalInstallationError(
          "inspect",
          "Local installation lifecycle recovery failed.",
          error,
        );
      }
    },

    inspect,

    async start() {
      let lifecycle: StoredLifecycle | undefined;
      let startedFromStopped = false;
      let operation: StoredLifecycle["operation"];
      try {
        releaseAbandonedOperationForStart(paths.lifecycleJournal);
        lifecycle = claimLifecycleOperation(paths.lifecycleJournal, "start");
        operation = lifecycle.operation;
        startedFromStopped = lifecycle.stopped;
        if (lifecycle.stopped) {
          await withActor(lifecycle.actor, (actor) => actor.resetLeadRestartBudget(3));
        }
        writeLifecycle(paths.lifecycleJournal, {
          ...lifecycle,
          stopRequested: false,
          stopped: false,
        });
        await options.supervision.start();
        return await connectHost(hostAddress);
      } catch (error) {
        if (lifecycle && startedFromStopped) {
          try {
            await options.supervision.stop();
          } catch {
            // Preserve the original start failure; inspection still reports the safe stopped intent.
          }
          writeLifecycle(paths.lifecycleJournal, {
            ...lifecycle,
            stopRequested: true,
            stopped: true,
          });
        }
        if (error instanceof LocalInstallationError) throw error;
        throw new LocalInstallationError("start", "Local installation start or attachment failed.", error);
      } finally {
        if (operation) releaseLifecycleOperation(paths.lifecycleJournal, operation.id);
      }
    },

    stop,

    async uninstall() {
      let operation: StoredLifecycle["operation"];
      try {
        let lifecycle = requireInstalled();
        if (!lifecycle.stopped) await stop();
        lifecycle = claimLifecycleOperation(paths.lifecycleJournal, "uninstall");
        operation = lifecycle.operation;
        await options.supervision.unregister();
        await rm(paths.leadAgentVersions, { recursive: true, force: true });
        await rm(join(paths.root, "protected"), { recursive: true, force: true });
        await rm(paths.launcher, { recursive: true, force: true });
        writeLifecycle(paths.lifecycleJournal, {
          ...lifecycle,
          status: "uninstalled",
          stopRequested: true,
          stopped: true,
        });
      } catch (error) {
        if (error instanceof LocalInstallationError && error.operation === "uninstall") throw error;
        throw new LocalInstallationError(
          "uninstall",
          "Local installation uninstall failed; preserved data was not removed.",
          error,
        );
      } finally {
        if (operation) releaseLifecycleOperation(paths.lifecycleJournal, operation.id);
      }
    },
  };
}

function releaseActorIdentity(release: VerifiedLocalRelease): RecoveryActorIdentity {
  return {
    revision: release.identity.revision,
    digest: release.identity.digest,
    path: release.path,
  };
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

function requireSameInitialIdentity(
  initialized: ReturnType<RecoveryActor["inspect"]>,
  actor: RecoveryActorIdentity,
  leadRelease: VerifiedLocalRelease,
  stateRevision: string,
): void {
  if (
    initialized.actor?.revision !== actor.revision ||
    initialized.actor.digest !== actor.digest ||
    resolve(initialized.actor.path) !== resolve(actor.path) ||
    initialized.active?.code.revision !== leadRelease.identity.revision ||
    initialized.active.code.digest !== leadRelease.identity.digest ||
    initialized.active.state.revision !== stateRevision
  ) {
    throw new Error("Existing Recovery Actor initialization does not match this installation request.");
  }
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

async function writeLauncherManifest(
  paths: LocalInstallationPaths,
  hostAddress: string,
  actor: VerifiedLocalRelease,
  leadAgent: VerifiedLocalRelease,
): Promise<void> {
  await mkdir(paths.launcher, { recursive: true });
  const ownerLauncherRelativePath = "dist/owner-launcher.js";
  if (!leadAgent.manifest.files.some((file) => file.path === ownerLauncherRelativePath)) {
    throw new Error("The Lead Agent release does not contain its Owner launcher.");
  }
  const installedOwnerLauncherPath = join(
    leadAgent.path,
    ...ownerLauncherRelativePath.split("/"),
  );
  await writeFile(
    join(paths.launcher, "installation.json"),
    `${JSON.stringify({
      formatVersion: 1,
      hostAddress,
      actor: {
        identity: actor.identity,
        path: actor.path,
        entrypointPath: actor.entrypointPath,
        runtimePath: actor.runtime.path,
      },
      leadAgent: {
        identity: leadAgent.identity,
        path: leadAgent.path,
        entrypointPath: leadAgent.entrypointPath,
        runtimePath: leadAgent.runtime.path,
      },
      stateDirectory: paths.state,
      recoveryDirectory: paths.recovery,
      journalDirectory: paths.journal,
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(paths.launcher, "riker.cmd"),
    `@echo off\r\n"${actor.runtime.path}" "${installedOwnerLauncherPath}" --install-root "${paths.root}" %*\r\n`,
    "utf8",
  );
}

function readLifecycle(path: string): StoredLifecycle | undefined {
  if (!existsSync(path)) return undefined;
  const database = openLifecycleDatabase(path);
  try {
    const row = database
      .prepare(`
        SELECT status, stop_requested, stopped, actor_json, operation_json
          FROM local_installation
         WHERE singleton = 1
      `)
      .get() as {
        status: StoredLifecycle["status"];
        stop_requested: number;
        stopped: number;
        actor_json: string;
        operation_json: string | null;
      } | undefined;
    return row
      ? {
          status: row.status,
          stopRequested: row.stop_requested === 1,
          stopped: row.stopped === 1,
          actor: JSON.parse(row.actor_json) as RecoveryActorIdentity,
          ...(row.operation_json
            ? { operation: JSON.parse(row.operation_json) as NonNullable<StoredLifecycle["operation"]> }
            : {}),
        }
      : undefined;
  } finally {
    database.close();
  }
}

function writeLifecycle(path: string, lifecycle: StoredLifecycle): void {
  const database = openLifecycleDatabase(path);
  try {
    database
      .prepare(`
        INSERT INTO local_installation (
          singleton, status, stop_requested, stopped, actor_json, operation_json, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          status = excluded.status,
          stop_requested = excluded.stop_requested,
          stopped = excluded.stopped,
          actor_json = excluded.actor_json,
          operation_json = excluded.operation_json,
          updated_at = excluded.updated_at
      `)
      .run(
        lifecycle.status,
        lifecycle.stopRequested ? 1 : 0,
        lifecycle.stopped ? 1 : 0,
        JSON.stringify(lifecycle.actor),
        lifecycle.operation ? JSON.stringify(lifecycle.operation) : null,
        new Date().toISOString(),
      );
  } finally {
    database.close();
  }
}

function openLifecycleDatabase(path: string): DatabaseSync {
  const directory = dirname(path);
  const database = (() => {
    // DatabaseSync cannot create its parent directory.
    if (!existsSync(directory)) throw new Error("Local installation journal directory is missing.");
    return new DatabaseSync(path);
  })();
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS local_installation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      status TEXT NOT NULL CHECK (status IN (
        'prepared', 'installed', 'registration-failed', 'uninstalled'
      )),
      stop_requested INTEGER NOT NULL CHECK (stop_requested IN (0, 1)),
      stopped INTEGER NOT NULL CHECK (stopped IN (0, 1)),
      actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
      operation_json TEXT CHECK (operation_json IS NULL OR json_valid(operation_json)),
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  return database;
}

function claimLifecycleOperation(
  path: string,
  kind: NonNullable<StoredLifecycle["operation"]>["kind"],
): StoredLifecycle {
  const database = openLifecycleDatabase(path);
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database
      .prepare(`
        SELECT status, stop_requested, stopped, actor_json, operation_json
          FROM local_installation
         WHERE singleton = 1
      `)
      .get() as {
      status: StoredLifecycle["status"];
      stop_requested: number;
      stopped: number;
      actor_json: string;
      operation_json: string | null;
    } | undefined;
    if (!row || row.status !== "installed") throw new Error("Local installation is not installed.");
    if (row.operation_json) {
      const current = JSON.parse(row.operation_json) as NonNullable<StoredLifecycle["operation"]>;
      throw new Error(`Local installation operation ${current.kind} is already in progress.`);
    }
    const operation = {
      id: randomUUID(),
      kind,
      pid: process.pid,
      startedAt: processStartedAt(process.pid) ?? new Date().toISOString(),
    };
    database
      .prepare("UPDATE local_installation SET operation_json = ?, updated_at = ? WHERE singleton = 1")
      .run(JSON.stringify(operation), new Date().toISOString());
    database.exec("COMMIT");
    return {
      status: row.status,
      stopRequested: row.stop_requested === 1,
      stopped: row.stopped === 1,
      actor: JSON.parse(row.actor_json) as RecoveryActorIdentity,
      operation,
    };
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
      .prepare("SELECT operation_json FROM local_installation WHERE singleton = 1")
      .get() as { operation_json: string | null } | undefined;
    if (!row?.operation_json) return;
    const operation = JSON.parse(row.operation_json) as NonNullable<StoredLifecycle["operation"]>;
    if (operation.id !== operationId) return;
    database
      .prepare(`
        UPDATE local_installation
           SET operation_json = NULL, updated_at = ?
         WHERE singleton = 1 AND operation_json = ?
      `)
      .run(new Date().toISOString(), row.operation_json);
  } finally {
    database.close();
  }
}

function releaseAbandonedOperationForStart(path: string): void {
  const lifecycle = readLifecycle(path);
  const operation = lifecycle?.operation;
  if (
    !operation ||
    operation.kind === "uninstall" ||
    processMatches(operation.pid, operation.startedAt)
  ) return;
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
