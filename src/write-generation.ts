import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const authoritativeStateSchemaRevision = 1;
const writeGenerationHighWaterFile = "write-generation-journal.sqlite";

export class StaleWriteGenerationError extends Error {
  constructor(expected: number, actual: number) {
    super(`Authoritative State write generation ${expected} is stale; active generation is ${actual}.`);
  }
}

export function ensureWriteGenerationSchema(database: DatabaseSync): void {
  if (hasLifecycleMetadata(database)) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!hasLifecycleMetadata(database)) {
      database.exec(`
        CREATE TABLE lifecycle_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_revision INTEGER NOT NULL CHECK (schema_revision > 0),
          write_generation INTEGER NOT NULL CHECK (write_generation > 0),
          probe_nonce TEXT
        ) STRICT;
        INSERT INTO lifecycle_metadata (singleton, schema_revision, write_generation, probe_nonce)
          VALUES (1, ${authoritativeStateSchemaRevision}, 1, NULL);
      `);
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function hasLifecycleMetadata(database: DatabaseSync): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lifecycle_metadata'")
      .get(),
  );
}

export function readWriteGeneration(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT write_generation FROM lifecycle_metadata WHERE singleton = 1")
    .get() as { write_generation: number } | undefined;
  if (!row) throw new Error("Authoritative State write generation is unavailable.");
  return row.write_generation;
}

export function assertWriteGeneration(database: DatabaseSync, expected: number): void {
  const actual = readWriteGeneration(database);
  if (actual !== expected) throw new StaleWriteGenerationError(expected, actual);
}

export function advanceWriteGeneration(stateDirectory: string, expected: number): number {
  const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"));
  try {
    database.exec("PRAGMA synchronous = FULL;");
    ensureWriteGenerationSchema(database);
    database.exec("BEGIN IMMEDIATE");
    const actual = readWriteGeneration(database);
    if (actual !== expected) {
      throw new Error(`Cannot transfer Authoritative State: expected write generation ${expected}; found ${actual}.`);
    }
    const next = expected + 1;
    recordWriteGenerationHighWater(stateDirectory, next);
    database
      .prepare("UPDATE lifecycle_metadata SET write_generation = ?, probe_nonce = NULL WHERE singleton = 1")
      .run(next);
    database.exec("COMMIT");
    return next;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export function readWriteGenerationHighWater(stateDirectory: string): number | undefined {
  const path = join(stateDirectory, writeGenerationHighWaterFile);
  if (!existsSync(path)) return undefined;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT high_water FROM write_generation_high_water WHERE singleton = 1")
      .get() as { high_water: number } | undefined;
    if (!row || !Number.isSafeInteger(row.high_water) || row.high_water < 1) {
      throw new Error("Authoritative State write-generation high-water mark is invalid.");
    }
    return row.high_water;
  } finally {
    database.close();
  }
}

export function recordWriteGenerationHighWater(
  stateDirectory: string,
  writeGeneration: number,
): number {
  if (!Number.isSafeInteger(writeGeneration) || writeGeneration < 1) {
    throw new Error("Authoritative State write-generation high-water mark must be positive.");
  }
  const path = join(stateDirectory, writeGenerationHighWaterFile);
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS write_generation_high_water (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        high_water INTEGER NOT NULL CHECK (high_water > 0)
      ) STRICT;
      BEGIN IMMEDIATE;
    `);
    database
      .prepare(`
        INSERT INTO write_generation_high_water (singleton, high_water)
        VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          high_water = MAX(write_generation_high_water.high_water, excluded.high_water)
      `)
      .run(writeGeneration);
    const row = database
      .prepare("SELECT high_water FROM write_generation_high_water WHERE singleton = 1")
      .get() as { high_water: number };
    database.exec("COMMIT");
    return row.high_water;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
