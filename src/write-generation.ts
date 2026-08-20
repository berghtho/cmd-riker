import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const authoritativeStateSchemaRevision = 1;

export class StaleWriteGenerationError extends Error {
  constructor(expected: number, actual: number) {
    super(`Authoritative State write generation ${expected} is stale; active generation is ${actual}.`);
  }
}

export function ensureWriteGenerationSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_revision INTEGER NOT NULL CHECK (schema_revision > 0),
      write_generation INTEGER NOT NULL CHECK (write_generation > 0),
      probe_nonce TEXT
    ) STRICT;
    INSERT INTO lifecycle_metadata (singleton, schema_revision, write_generation, probe_nonce)
      VALUES (1, ${authoritativeStateSchemaRevision}, 1, NULL)
      ON CONFLICT(singleton) DO NOTHING;
  `);
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
  database.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
  try {
    ensureWriteGenerationSchema(database);
    const actual = readWriteGeneration(database);
    if (actual !== expected) {
      throw new Error(`Cannot transfer Authoritative State: expected write generation ${expected}; found ${actual}.`);
    }
    const next = expected + 1;
    database
      .prepare("UPDATE lifecycle_metadata SET write_generation = ?, probe_nonce = NULL WHERE singleton = 1")
      .run(next);
    database.exec("COMMIT");
    return next;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
