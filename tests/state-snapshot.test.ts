import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createAuthoritativeStateSnapshot,
  recoverInterruptedAuthoritativeStateRestore,
  restoreAuthoritativeStateSnapshot,
} from "../src/state-snapshot/index.ts";
import { ensureWriteGenerationSchema } from "../src/write-generation.ts";

const databaseFileName = "authoritative-state.sqlite";

test("SQLite backup captures committed Authoritative State still resident in WAL", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-state-snapshot-wal-"));
  const stateDirectory = join(root, "state");
  const recoveryDirectory = join(root, "recovery");
  await mkdir(stateDirectory);

  const databasePath = join(stateDirectory, databaseFileName);
  const live = new DatabaseSync(databasePath);
  t.after(() => live.close());
  t.after(() => rm(root, { recursive: true, force: true }));
  live.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  ensureWriteGenerationSchema(live);
  live.exec(`
    CREATE TABLE rollback_facts (value TEXT PRIMARY KEY) STRICT;
    INSERT INTO rollback_facts VALUES ('checkpointed');
    PRAGMA wal_checkpoint(TRUNCATE);
    INSERT INTO rollback_facts VALUES ('wal-only');
  `);
  assert.ok((await stat(`${databasePath}-wal`)).size > 0);

  const snapshot = await createAuthoritativeStateSnapshot({
    stateDirectory,
    recoveryDirectory,
    revision: "state-revision-1",
    provenance: "activation-attempt-wal",
  });

  assert.equal(snapshot.revision, "state-revision-1");
  assert.equal(snapshot.writeGeneration, 1);
  assert.equal(snapshot.provenance, "activation-attempt-wal");
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
  assert.equal(
    snapshot.digest,
    createHash("sha256").update(await readFile(snapshot.path)).digest("hex"),
  );
  const recovered = new DatabaseSync(snapshot.path, { readOnly: true });
  assert.deepEqual(
    (recovered.prepare("SELECT value FROM rollback_facts ORDER BY value").all() as Array<{ value: string }>).map(
      (row) => row.value,
    ),
    ["checkpointed", "wal-only"],
  );
  recovered.close();
});

test("restore installs the exact rollback state under a fresh generation and retains failed files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-state-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  const recoveryDirectory = join(root, "recovery");
  const evidenceDirectory = join(root, "evidence");
  await mkdir(stateDirectory);

  const databasePath = join(stateDirectory, databaseFileName);
  const failed = new DatabaseSync(databasePath);
  failed.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
  ensureWriteGenerationSchema(failed);
  failed.exec(`
    CREATE TABLE rollback_facts (value TEXT PRIMARY KEY) STRICT;
    INSERT INTO rollback_facts VALUES ('protected baseline');
  `);
  const snapshot = await createAuthoritativeStateSnapshot({
    stateDirectory,
    recoveryDirectory,
    revision: "state-baseline-1",
    provenance: "activation-attempt-rollback",
  });

  failed.exec(`
    UPDATE lifecycle_metadata SET write_generation = 2 WHERE singleton = 1;
    DELETE FROM rollback_facts;
    INSERT INTO rollback_facts VALUES ('failed candidate state');
  `);
  const failedPaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
  const failedBytes = await Promise.all(failedPaths.map((path) => readFile(path)));
  failed.close();
  await Promise.all(failedPaths.map((path, index) => writeFile(path, failedBytes[index]!)));

  const restored = await restoreAuthoritativeStateSnapshot({
    stateDirectory,
    evidenceDirectory,
    snapshot,
    expectedDigest: snapshot.digest,
    failedWriteGeneration: 2,
    freshWriteGeneration: 3,
  });

  assert.equal(restored.revision, snapshot.revision);
  assert.equal(restored.provenance, snapshot.provenance);
  assert.equal(restored.path, databasePath);
  assert.equal(restored.writeGeneration, 3);
  assert.match(restored.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    restored.failedFiles,
    failedPaths.map((path) => join(evidenceDirectory, basename(path))),
  );

  const active = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(
    (active.prepare("SELECT value FROM rollback_facts").all() as Array<{ value: string }>).map(
      (row) => row.value,
    ),
    ["protected baseline"],
  );
  const lifecycle = active
    .prepare("SELECT write_generation, probe_nonce FROM lifecycle_metadata WHERE singleton = 1")
    .get() as { write_generation: number; probe_nonce: string | null };
  assert.equal(lifecycle.write_generation, 3);
  assert.equal(lifecycle.probe_nonce, null);
  assert.equal(
    (active.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
    "ok",
  );
  active.close();

  for (const [index, path] of failedPaths.entries()) {
    assert.deepEqual(await readFile(join(evidenceDirectory, basename(path))), failedBytes[index]);
  }
});

test("restore refusals leave active Authoritative State untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-state-restore-refusal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  const recoveryDirectory = join(root, "recovery");
  await mkdir(stateDirectory);

  const databasePath = join(stateDirectory, databaseFileName);
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL;");
  ensureWriteGenerationSchema(database);
  database.exec(`
    CREATE TABLE rollback_facts (value TEXT PRIMARY KEY) STRICT;
    INSERT INTO rollback_facts VALUES ('active');
  `);
  const snapshot = await createAuthoritativeStateSnapshot({
    stateDirectory,
    recoveryDirectory,
    revision: "state-refusal-1",
    provenance: "activation-attempt-refusal",
  });
  database.exec("UPDATE lifecycle_metadata SET write_generation = 2 WHERE singleton = 1;");
  database.close();
  const activeBytes = await readFile(databasePath);

  const restore = (
    evidenceName: string,
    overrides: Partial<Parameters<typeof restoreAuthoritativeStateSnapshot>[0]> = {},
  ) => restoreAuthoritativeStateSnapshot({
    stateDirectory,
    evidenceDirectory: join(root, evidenceName),
    snapshot,
    expectedDigest: snapshot.digest,
    failedWriteGeneration: 2,
    freshWriteGeneration: 3,
    ...overrides,
  });

  await assert.rejects(
    restore("evidence-digest-identity", { expectedDigest: "f".repeat(64) }),
    /expected digest does not match/,
  );
  assert.deepEqual(await readFile(databasePath), activeBytes);

  await assert.rejects(
    restore("evidence-provenance", { snapshot: { ...snapshot, provenance: "" } }),
    /provenance is required/,
  );
  assert.deepEqual(await readFile(databasePath), activeBytes);

  await assert.rejects(
    restore("evidence-generation", { freshWriteGeneration: 2 }),
    /newer than the failed generation/,
  );
  assert.deepEqual(await readFile(databasePath), activeBytes);

  await appendFile(snapshot.path, "tampered");
  await assert.rejects(restore("evidence-tamper"), /snapshot digest mismatch/);
  assert.deepEqual(await readFile(databasePath), activeBytes);
  await assert.rejects(stat(join(root, "evidence-tamper")), { code: "ENOENT" });
});

test("a durable restore journal resumes after the active database was displaced", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-state-restore-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  const recoveryDirectory = join(root, "snapshots");
  const failedEvidenceRoot = join(root, "failed-evidence");
  const evidenceDirectory = join(failedEvidenceRoot, "generation-2-resume");
  await mkdir(stateDirectory);
  const databasePath = join(stateDirectory, databaseFileName);
  const database = new DatabaseSync(databasePath);
  ensureWriteGenerationSchema(database);
  database.exec("CREATE TABLE facts_for_resume (value TEXT); INSERT INTO facts_for_resume VALUES ('baseline');");
  const snapshot = await createAuthoritativeStateSnapshot({
    stateDirectory,
    recoveryDirectory,
    revision: "resume-baseline",
    provenance: "restore crash injection",
  });
  database.exec("UPDATE lifecycle_metadata SET write_generation = 2; DELETE FROM facts_for_resume; INSERT INTO facts_for_resume VALUES ('failed');");
  database.close();
  await restoreAuthoritativeStateSnapshot({
    stateDirectory,
    evidenceDirectory,
    snapshot,
    expectedDigest: snapshot.digest,
    failedWriteGeneration: 2,
    freshWriteGeneration: 3,
  });

  const journalPath = join(evidenceDirectory, "restore-journal.json");
  const journalLines = (await readFile(journalPath, "utf8")).trim().split(/\r?\n/);
  const journal = JSON.parse(journalLines.at(-1)!) as {
    phase: string;
    stagedPath: string;
    activePath: string;
    displaced: Array<{ activePath: string; displacedPath: string }>;
    displacedCount: number;
  };
  await copyFile(journal.activePath, journal.stagedPath);
  await rm(journal.activePath);
  await copyFile(join(evidenceDirectory, databaseFileName), journal.activePath);
  const mainPlan = journal.displaced.find((plan) => plan.activePath === journal.activePath);
  assert(mainPlan);
  await rename(mainPlan.activePath, mainPlan.displacedPath);
  journal.phase = "displacing";
  journal.displacedCount = 1;
  await appendFile(journalPath, `${JSON.stringify(journal)}\n`);

  assert.equal(await recoverInterruptedAuthoritativeStateRestore(failedEvidenceRoot), 3);
  const recovered = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    (recovered.prepare("SELECT value FROM facts_for_resume").get() as { value: string }).value,
    "baseline",
  );
  recovered.close();

  await rm(databasePath);
  await copyFile(join(evidenceDirectory, databaseFileName), databasePath);
  journal.phase = "prepared";
  journal.displacedCount = 0;
  await appendFile(
    journalPath,
    `${JSON.stringify(journal)}\n{"formatVersion":1,"phase":"aborted"`,
  );
  assert.equal(await recoverInterruptedAuthoritativeStateRestore(failedEvidenceRoot), undefined);
  const safelyAborted = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    (safelyAborted.prepare("SELECT value FROM facts_for_resume").get() as { value: string }).value,
    "failed",
  );
  safelyAborted.close();
});
