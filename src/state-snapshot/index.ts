import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import {
  readWriteGenerationHighWater,
  recordWriteGenerationHighWater,
} from "../write-generation.ts";

export type AuthoritativeStateSnapshot = {
  revision: string;
  digest: string;
  path: string;
  writeGeneration: number;
  provenance: string;
};

export type AuthoritativeStateRestore = AuthoritativeStateSnapshot & {
  evidencePath: string;
  failedFiles: string[];
};

export type AuthoritativeStateSnapshotInput = {
  stateDirectory: string;
  recoveryDirectory: string;
  revision: string;
  provenance: string;
};

export type AuthoritativeStateRestoreInput = {
  stateDirectory: string;
  evidenceDirectory: string;
  snapshot: AuthoritativeStateSnapshot;
  expectedDigest: string;
  failedWriteGeneration: number;
  freshWriteGeneration: number;
};

const databaseFileName = "authoritative-state.sqlite";
const stateFileNames = [databaseFileName, `${databaseFileName}-wal`, `${databaseFileName}-shm`];
const digestPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type RestoreJournal = {
  formatVersion: 1;
  phase: "prepared" | "displacing" | "installed" | "completed" | "aborted";
  stateDirectory: string;
  stagedPath: string;
  activePath: string;
  displaced: Array<{ activePath: string; displacedPath: string }>;
  displacedCount: number;
  snapshot: AuthoritativeStateSnapshot;
  failedWriteGeneration: number;
  freshWriteGeneration: number;
  evidenceDirectory: string;
  failedFiles: string[];
};

export async function createAuthoritativeStateSnapshot(
  input: AuthoritativeStateSnapshotInput,
): Promise<AuthoritativeStateSnapshot> {
  validateRevision(input.revision);
  validateProvenance(input.provenance);

  const sourcePath = resolve(input.stateDirectory, databaseFileName);
  const recoveryDirectory = resolve(input.recoveryDirectory);
  await mkdir(recoveryDirectory, { recursive: true });

  const identity = randomUUID();
  const completedPath = join(
    recoveryDirectory,
    `authoritative-state.${input.revision}.${identity}.sqlite`,
  );
  const partialPath = `${completedPath}.partial`;
  let source: DatabaseSync | undefined;
  let completed = false;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    await backup(source, partialPath);
    source.close();
    source = undefined;

    const lifecycle = inspectDatabase(partialPath);
    await syncFile(partialPath);
    await rename(partialPath, completedPath);
    completed = true;
    const digest = await fileDigest(completedPath);

    return {
      revision: input.revision,
      digest,
      path: completedPath,
      writeGeneration: lifecycle.writeGeneration,
      provenance: input.provenance,
    };
  } catch (error) {
    source?.close();
    await rm(partialPath, { force: true });
    if (completed) await rm(completedPath, { force: true });
    throw error;
  }
}

export async function restoreAuthoritativeStateSnapshot(
  input: AuthoritativeStateRestoreInput,
): Promise<AuthoritativeStateRestore> {
  validateSnapshot(input.snapshot);
  validateDigest(input.expectedDigest, "Expected snapshot digest");
  if (input.snapshot.digest !== input.expectedDigest) {
    throw new Error("Supplied expected digest does not match the Authoritative State snapshot identity.");
  }
  validateGeneration(input.failedWriteGeneration, "Failed write generation");
  validateGeneration(input.freshWriteGeneration, "Fresh write generation");
  if (input.freshWriteGeneration <= input.failedWriteGeneration) {
    throw new Error("Restored Authoritative State requires a write generation newer than the failed generation.");
  }

  const stateDirectory = resolve(input.stateDirectory);
  const highWaterGeneration = readWriteGenerationHighWater(stateDirectory) ?? 0;
  if (input.freshWriteGeneration <= highWaterGeneration) {
    throw new Error(
      "Restored Authoritative State requires a write generation above the durable high-water mark.",
    );
  }
  const evidenceDirectory = resolve(input.evidenceDirectory);
  const activePath = join(stateDirectory, databaseFileName);
  const snapshotPath = resolve(input.snapshot.path);
  if (snapshotPath === activePath) {
    throw new Error("An active Authoritative State database cannot serve as its own recovery snapshot.");
  }
  if (evidenceDirectory === stateDirectory) {
    throw new Error("Failed Authoritative State evidence requires a separate directory.");
  }

  await mkdir(stateDirectory, { recursive: true });
  const restoreIdentity = randomUUID();
  const stagedPath = join(stateDirectory, `.${databaseFileName}.restore-${restoreIdentity}`);
  const displaced = new Map<string, string>();
  const journalPath = join(evidenceDirectory, "restore-journal.json");
  let journal: RestoreJournal | undefined;
  let stageExists = false;
  let installed = false;

  try {
    await copyFile(snapshotPath, stagedPath, constants.COPYFILE_EXCL);
    stageExists = true;
    const stagedDigest = await fileDigest(stagedPath);
    if (stagedDigest !== input.expectedDigest) {
      throw new Error("Authoritative State snapshot digest mismatch; restore was refused.");
    }

    const snapshotLifecycle = inspectDatabase(stagedPath);
    if (snapshotLifecycle.writeGeneration !== input.snapshot.writeGeneration) {
      throw new Error("Authoritative State snapshot write-generation identity does not match its database.");
    }
    setWriteGeneration(stagedPath, input.freshWriteGeneration, {
      snapshotDigest: input.snapshot.digest,
      snapshotRevision: input.snapshot.revision,
      failedWriteGeneration: input.failedWriteGeneration,
    });
    const stagedLifecycle = inspectDatabase(stagedPath);
    if (stagedLifecycle.writeGeneration !== input.freshWriteGeneration) {
      throw new Error("Restored Authoritative State did not retain the fresh write generation.");
    }
    await syncFile(stagedPath);

    const activeFiles = await existingStateFiles(stateDirectory);
    await mkdir(evidenceDirectory, { recursive: true });
    const failedFiles: string[] = [];
    for (const path of activeFiles) {
      const evidencePath = join(evidenceDirectory, basename(path));
      await copyFile(path, evidencePath, constants.COPYFILE_EXCL);
      await syncFile(evidencePath);
      failedFiles.push(evidencePath);
    }

    const displacementPlan = activeFiles.map((path) => ({
      activePath: path,
      displacedPath: join(stateDirectory, `.${basename(path)}.failed-${restoreIdentity}`),
    }));
    journal = {
      formatVersion: 1,
      phase: "prepared",
      stateDirectory,
      stagedPath,
      activePath,
      displaced: displacementPlan,
      displacedCount: 0,
      snapshot: input.snapshot,
      failedWriteGeneration: input.failedWriteGeneration,
      freshWriteGeneration: input.freshWriteGeneration,
      evidenceDirectory,
      failedFiles,
    };
    recordWriteGenerationHighWater(stateDirectory, input.freshWriteGeneration);
    await writeRestoreJournal(journalPath, journal);

    for (const [index, plan] of displacementPlan.toReversed().entries()) {
      await rename(plan.activePath, plan.displacedPath);
      displaced.set(plan.activePath, plan.displacedPath);
      journal.phase = "displacing";
      journal.displacedCount = index + 1;
      await writeRestoreJournal(journalPath, journal);
    }
    await rename(stagedPath, activePath);
    stageExists = false;
    installed = true;
    journal.phase = "installed";
    await writeRestoreJournal(journalPath, journal);

    const installedLifecycle = inspectDatabase(activePath);
    if (installedLifecycle.writeGeneration !== input.freshWriteGeneration) {
      throw new Error("Installed Authoritative State failed fresh-generation verification.");
    }
    const digest = await fileDigest(activePath);

    await Promise.allSettled([...displaced.values()].map((path) => rm(path, { force: true })));
    journal.phase = "completed";
    await writeRestoreJournal(journalPath, journal);
    return {
      revision: input.snapshot.revision,
      digest,
      path: activePath,
      writeGeneration: input.freshWriteGeneration,
      provenance: input.snapshot.provenance,
      evidencePath: evidenceDirectory,
      failedFiles,
    };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (installed) {
      try {
        await rm(activePath, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const [path, displacedPath] of [...displaced.entries()].toReversed()) {
      try {
        await rename(displacedPath, path);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (stageExists) {
      try {
        await rm(stagedPath, { force: true });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Authoritative State restore failed and its active-file rollback was incomplete.",
      );
    }
    if (journal) {
      journal.phase = "aborted";
      await writeRestoreJournal(journalPath, journal);
    }
    throw error;
  }
}

export async function recoverInterruptedAuthoritativeStateRestore(
  failedEvidenceRoot: string,
): Promise<number | undefined> {
  const rootEntries = await readdir(failedEvidenceRoot, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    },
  );
  const journals: Array<{ path: string; value: RestoreJournal }> = [];
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue;
    const path = join(failedEvidenceRoot, entry.name, "restore-journal.json");
    const value = await readRestoreJournal(path);
    if (value && !["completed", "aborted"].includes(value.phase)) journals.push({ path, value });
  }
  if (journals.length === 0) return undefined;
  if (journals.length > 1) {
    throw new Error("Multiple interrupted Authoritative State restores require Owner reconciliation.");
  }
  const { path, value } = journals[0]!;
  if (await pathExists(value.activePath)) {
    try {
      const activeGeneration = inspectDatabase(value.activePath).writeGeneration;
      if (activeGeneration === value.freshWriteGeneration) {
        value.phase = "completed";
        await writeRestoreJournal(path, value);
        await Promise.allSettled(
          value.displaced.map((plan) => rm(plan.displacedPath, { force: true })),
        );
        return value.freshWriteGeneration;
      }
      if (
        activeGeneration === value.failedWriteGeneration &&
        !await pathExists(value.stagedPath)
      ) {
        value.phase = "aborted";
        await writeRestoreJournal(path, value);
        return undefined;
      }
    } catch {
      // A partial failed database is handled from the durable displacement plan below.
    }
  }
  for (const plan of value.displaced.toReversed()) {
    const activeExists = await pathExists(plan.activePath);
    const displacedExists = await pathExists(plan.displacedPath);
    if (activeExists && displacedExists) {
      throw new Error("Interrupted restore has ambiguous active and displaced state files.");
    }
    if (activeExists) await rename(plan.activePath, plan.displacedPath);
    else if (!displacedExists) {
      throw new Error("Interrupted restore is missing both active and displaced state evidence.");
    }
  }
  if (await pathExists(value.stagedPath)) {
    if (await pathExists(value.activePath)) {
      throw new Error("Interrupted restore cannot replace an ambiguous active database.");
    }
    await rename(value.stagedPath, value.activePath);
  }
  const lifecycle = inspectDatabase(value.activePath);
  if (lifecycle.writeGeneration !== value.freshWriteGeneration) {
    throw new Error("Recovered restore does not contain its recorded fresh write generation.");
  }
  value.phase = "completed";
  await writeRestoreJournal(path, value);
  await Promise.allSettled(
    value.displaced.map((plan) => rm(plan.displacedPath, { force: true })),
  );
  return value.freshWriteGeneration;
}

function inspectDatabase(path: string): { schemaRevision: number; writeGeneration: number } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrityRows = database.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
      const detail = integrityRows.map((row) => row.integrity_check).join("; ") || "no result";
      throw new Error(`Authoritative State integrity check failed: ${detail}.`);
    }
    const lifecycle = database
      .prepare(`
        SELECT schema_revision, write_generation
          FROM lifecycle_metadata
         WHERE singleton = 1
      `)
      .get() as { schema_revision: number; write_generation: number } | undefined;
    if (!lifecycle) {
      throw new Error("Authoritative State snapshot is missing lifecycle metadata.");
    }
    validateGeneration(lifecycle.schema_revision, "Authoritative State schema revision");
    validateGeneration(lifecycle.write_generation, "Authoritative State write generation");
    return {
      schemaRevision: lifecycle.schema_revision,
      writeGeneration: lifecycle.write_generation,
    };
  } finally {
    database.close();
  }
}

function setWriteGeneration(
  path: string,
  generation: number,
  restore: {
    snapshotDigest: string;
    snapshotRevision: string;
    failedWriteGeneration: number;
  },
): void {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
    const result = database
      .prepare(`
        UPDATE lifecycle_metadata
           SET write_generation = ?, probe_nonce = NULL
         WHERE singleton = 1
      `)
      .run(generation);
    if (result.changes !== 1) {
      throw new Error("Authoritative State snapshot is missing write-generation metadata.");
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS recovery_restore_marker (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        snapshot_digest TEXT NOT NULL,
        snapshot_revision TEXT NOT NULL,
        failed_write_generation INTEGER NOT NULL,
        restored_write_generation INTEGER NOT NULL
      ) STRICT;
    `);
    database
      .prepare(`
        INSERT OR REPLACE INTO recovery_restore_marker (
          singleton, snapshot_digest, snapshot_revision,
          failed_write_generation, restored_write_generation
        ) VALUES (1, ?, ?, ?, ?)
      `)
      .run(
        restore.snapshotDigest,
        restore.snapshotRevision,
        restore.failedWriteGeneration,
        generation,
      );
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

async function existingStateFiles(stateDirectory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const fileName of stateFileNames) {
    const path = join(stateDirectory, fileName);
    try {
      const entry = await lstat(path);
      if (!entry.isFile()) {
        throw new Error(`Authoritative State path is not a regular file: ${path}.`);
      }
      paths.push(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return paths;
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeRestoreJournal(path: string, journal: RestoreJournal): Promise<void> {
  await writeFile(path, `\n${JSON.stringify(journal)}\n`, { encoding: "utf8", flag: "a" });
  await syncFile(path);
}

async function readRestoreJournal(path: string): Promise<RestoreJournal | undefined> {
  try {
    const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/);
    for (const line of lines.toReversed()) {
      if (!line) continue;
      try {
        const value = JSON.parse(line) as RestoreJournal;
        if (value.formatVersion !== 1) continue;
        return value;
      } catch {
        // A torn final append falls back to the preceding fsync-complete phase record.
      }
    }
    throw new Error("Restore journal has no complete supported phase record.");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function validateSnapshot(snapshot: AuthoritativeStateSnapshot): void {
  validateRevision(snapshot.revision);
  validateDigest(snapshot.digest, "Authoritative State snapshot digest");
  if (!snapshot.path.trim()) throw new Error("Authoritative State snapshot path is required.");
  validateGeneration(snapshot.writeGeneration, "Authoritative State snapshot write generation");
  validateProvenance(snapshot.provenance);
}

function validateRevision(revision: string): void {
  if (!revisionPattern.test(revision)) {
    throw new Error("Authoritative State snapshot revision must be a safe exact identifier.");
  }
}

function validateProvenance(provenance: string): void {
  if (!provenance.trim()) {
    throw new Error("Authoritative State snapshot provenance is required.");
  }
}

function validateDigest(digest: string, subject: string): void {
  if (!digestPattern.test(digest)) throw new Error(`${subject} must be an exact SHA-256 digest.`);
}

function validateGeneration(generation: number, subject: string): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`${subject} must be a positive safe integer.`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
