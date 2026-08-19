import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { backup as backupDatabase, DatabaseSync } from "node:sqlite";

import {
  assertSupportedModelSelection,
  type ModelSelection,
} from "../model-selection.ts";
import {
  assertSupportedWorkerModelSelection,
  type CapabilityNotice,
  type Commitment,
  type LeadTurnAttempt,
  type OwnerConfiguration,
  type WorkerExecutionAttempt,
  type WorkerQuestion,
  type WorkerSession,
} from "../orchestration-core/index.ts";
import {
  assertEffectEvidenceSupportsDisposition,
  assertExternalEffectEvidence,
} from "../target-project-operations/index.ts";
import type {
  EffectIntent,
  ExternalEffectEvidence,
  TargetProjectOperationEffectIntent,
  TargetProjectOperationAttempt,
  WorkerAssignmentEffectIntent,
} from "../target-project-operations/index.ts";

export type { ModelSelection } from "../model-selection.ts";
export type {
  CapabilityNotice,
  Commitment,
  CommitmentCriterion,
  CommitmentDraft,
  CommitmentState,
  LeadModelPolicy,
  LeadTurnAttempt,
  ModelCandidateValidation,
  OwnerConfiguration,
  WorkerExecutionAttempt,
  WorkerModelSelection,
  WorkerOutcome,
  WorkerQuestion,
  WorkerReportedOutcome,
  WorkerSession,
} from "../orchestration-core/index.ts";

export type ConversationMessage =
  | {
      sequence: number;
      role: "owner";
      content: string;
      turnId: string;
      modelSelection: ModelSelection;
      modelPolicyRevision: string;
      nativeHarness: null;
    }
  | {
      sequence: number;
      role: "lead-agent";
      content: string;
      turnId: string;
      modelSelection: ModelSelection;
      modelPolicyRevision: string;
      nativeHarness: null;
      selectionReason?: "fallback-after-ineligible-candidate";
    };

export type OwnerConversation = OwnerConfiguration & {
  messages: ConversationMessage[];
};

export type AuthoritativeStateRecovery = {
  version: 1;
  phase: "damaged-state" | "post-backup-reconciliation";
  mutationPolicy: "disabled";
  reason: string;
  detectedAt: string;
  damagedEvidenceDirectory: string;
  restoredBackup?: AuthoritativeStateBackup;
  postBackupInventory?: PostBackupEffectInventory;
  postBackupReconciliations?: PostBackupEffectReconciliation[];
};

export type AuthoritativeStateBackup = {
  version: 1;
  backupId: string;
  sourceStateId: string;
  writeGeneration: number;
  databasePath: string;
  sha256: string;
  createdAt: string;
  lastJournalSequence: number;
};

export type PostBackupEffectInventory = {
  assessedAt: string;
  source: "external-effect-inventory";
  reference: string;
  summary: string;
  completenessEvidence: ExternalEffectEvidence & {
    source: "write-generation-and-effect-inventory-readback";
  };
  effects: Array<{
    id: string;
    scope: string;
    expectedEffect: string;
  }>;
};

export type PostBackupEffectReconciliation = {
  effectId: string;
  disposition: "confirmed-applied" | "confirmed-not-applied" | "compensated";
  evidence: ExternalEffectEvidence & {
    source: "target-project-readback" | "provider-readback" | "compensation-result";
  };
  reconciledAt: string;
  reconciledBy: "lead-agent";
};

export type AuthoritativeStateOpenResult =
  | { kind: "operational"; state: AuthoritativeState }
  | { kind: "recovery-required"; recovery: AuthoritativeStateRecovery };

export interface AuthoritativeState {
  storageStatus(): { journalMode: "wal" };
  initialize(configuration: OwnerConfiguration): void;
  replaceOwnerConfiguration(configuration: OwnerConfiguration): void;
  readOwnerConversation(): OwnerConversation | undefined;
  leadAgentResponse(ownerTurnId: string): string | undefined;
  appendOwnerMessage(content: string): string;
  appendLeadAgentMessage(
    turnId: string,
    content: string,
    attribution?: {
      modelSelection: ModelSelection;
      modelPolicyRevision: string;
      selectionReason?: "fallback-after-ineligible-candidate";
    },
  ): void;
  ownerTurnSequence(turnId: string): number | undefined;
  readCommitments(): Commitment[];
  readCommitment(commitmentId: string): Commitment | undefined;
  appendCommitmentSnapshots(snapshots: Commitment[]): void;
  appendLeadTurnAttemptSnapshots(snapshots: LeadTurnAttempt[]): void;
  readLeadTurnAttempt(attemptId: string): LeadTurnAttempt | undefined;
  readLeadTurnAttempts(): LeadTurnAttempt[];
  appendWorkerSessionSnapshots(snapshots: WorkerSession[]): void;
  readWorkerSession(workerSessionId: string): WorkerSession | undefined;
  readWorkerSessions(): WorkerSession[];
  appendWorkerExecutionAttemptSnapshots(snapshots: WorkerExecutionAttempt[]): void;
  readWorkerExecutionAttempt(attemptId: string): WorkerExecutionAttempt | undefined;
  readWorkerExecutionAttempts(): WorkerExecutionAttempt[];
  appendWorkerQuestionSnapshots(snapshots: WorkerQuestion[]): void;
  readWorkerQuestion(questionId: string): WorkerQuestion | undefined;
  readWorkerQuestions(): WorkerQuestion[];
  startWorkerExecution(
    workerSessionSnapshots: WorkerSession[],
    executionAttempt: WorkerExecutionAttempt,
    effectIntent?: EffectIntent,
  ): void;
  appendWorkerState(input: {
    workerSession?: WorkerSession;
    executionAttempt?: WorkerExecutionAttempt;
    questions?: WorkerQuestion[];
    effectIntent?: EffectIntent;
  }): void;
  settleWorkerVerification(
    effectIntent: WorkerAssignmentEffectIntent,
    commitmentSnapshots: Commitment[],
  ): void;
  readCapabilityNotice(id: CapabilityNotice["id"]): CapabilityNotice | undefined;
  appendCapabilityNotice(notice: CapabilityNotice): void;
  startTargetProjectOperation(
    attempt: TargetProjectOperationAttempt,
    effectIntent: TargetProjectOperationEffectIntent,
  ): void;
  claimTargetProjectOperationDispatch(
    attempt: TargetProjectOperationAttempt,
    effectIntent: TargetProjectOperationEffectIntent,
  ): void;
  settleTargetProjectOperation(
    attempt: TargetProjectOperationAttempt,
    effectIntent: TargetProjectOperationEffectIntent,
  ): void;
  readTargetProjectOperationAttempt(attemptId: string): TargetProjectOperationAttempt | undefined;
  readTargetProjectOperationAttempts(): TargetProjectOperationAttempt[];
  readEffectIntent(effectIntentId: string): EffectIntent | undefined;
  readEffectIntents(): EffectIntent[];
  reconcileEffectIntent(effectIntent: EffectIntent): void;
  readCommitmentHistory(commitmentId: string): Array<{
    sequence: number;
    commitment: Commitment;
  }>;
  createBackup(databasePath: string): Promise<AuthoritativeStateBackup>;
  close(): void;
}

type FactDraft =
  | { kind: "owner.configuration"; value: OwnerConfiguration }
  | {
      kind: "owner-conversation.owner-message";
      value: {
        content: string;
        turnId: string;
        modelSelection: ModelSelection;
        modelPolicyRevision: string;
      };
    }
  | {
      kind: "owner-conversation.lead-agent-message";
      value: {
        content: string;
        turnId: string;
        modelSelection: ModelSelection;
        modelPolicyRevision: string;
        selectionReason?: "fallback-after-ineligible-candidate";
      };
    }
  | { kind: "commitment.snapshot"; value: Commitment }
  | { kind: "lead-turn-attempt.snapshot"; value: LeadTurnAttempt }
  | { kind: "worker-session.snapshot"; value: WorkerSession }
  | { kind: "worker-execution-attempt.snapshot"; value: WorkerExecutionAttempt }
  | { kind: "worker-question.snapshot"; value: WorkerQuestion }
  | { kind: "capability-notice.snapshot"; value: CapabilityNotice }
  | { kind: "target-project-operation-attempt.snapshot"; value: TargetProjectOperationAttempt }
  | { kind: "effect-intent.snapshot"; value: EffectIntent };

type JournalRow = {
  sequence: number;
  id: string;
  kind: FactDraft["kind"];
  value_json: string;
};

type TransitionKind =
  | "owner.configuration-recorded"
  | "owner.model-policy-activated"
  | "owner-conversation.owner-message-recorded"
  | "owner-conversation.lead-agent-message-recorded"
  | `commitment.${Commitment["state"]}`
  | `lead-turn-attempt.${LeadTurnAttempt["status"]}`
  | `worker-session.${WorkerSession["state"]}`
  | `worker-execution-attempt.${WorkerExecutionAttempt["status"]}`
  | `worker-question.${WorkerQuestion["status"]}`
  | `capability-notice.${CapabilityNotice["state"]}`
  | `target-project-operation-attempt.${TargetProjectOperationAttempt["status"]}`
  | `effect-intent.${EffectIntent["status"]}`;

export function openAuthoritativeState(stateDirectory: string): AuthoritativeState {
  mkdirSync(stateDirectory, { recursive: true });
  if (loadRecoveryStatus(stateDirectory)) {
    throw new Error("Authoritative state recovery is active; product mutations are disabled.");
  }
  const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"));
  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    assertDatabaseIntegrity(database);
    ensureSchema(database);
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the original database failure; the next safe open captures the files as evidence.
    }
    throw error;
  }

  const readConfigurationRow = (): { id: string; value: OwnerConfiguration } | undefined => {
    const row = database
      .prepare(`
        SELECT id, value_json
          FROM facts current
         WHERE current.kind = 'owner.configuration'
           AND NOT EXISTS (
             SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
           )
         ORDER BY current.sequence DESC
         LIMIT 1
      `)
      .get() as { id: string; value_json: string } | undefined;
    if (!row) return undefined;
    return { id: row.id, value: parseConfiguration(row.value_json) };
  };

  const readCapabilityNoticeRow = (
    id: CapabilityNotice["id"],
  ): { id: string; value: CapabilityNotice } | undefined => {
    const row = database
      .prepare(`
        SELECT id, value_json
          FROM facts current
         WHERE current.kind = 'capability-notice.snapshot'
           AND current.subject_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
           )
         LIMIT 1
      `)
      .get(`capability-notice:${id}`) as { id: string; value_json: string } | undefined;
    return row
      ? { id: row.id, value: JSON.parse(row.value_json) as CapabilityNotice }
      : undefined;
  };

  const appendFact = (
    input: FactDraft,
    transitionKind: TransitionKind,
    supersedesFactId?: string,
  ): string => {
    const factId = randomUUID();
    const transitionId = randomUUID();
    const recordedAt = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(`
          INSERT INTO facts (
            id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          factId,
          factSubject(input),
          input.kind,
          JSON.stringify(input.value),
          supersedesFactId ?? null,
          recordedAt,
        );
      database
        .prepare(`
          INSERT INTO transitions (id, kind, fact_id, recorded_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(transitionId, transitionKind, factId, recordedAt);
      database.exec("COMMIT");
      return factId;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const readCommitmentRow = (
    commitmentId: string,
  ): { id: string; value: Commitment } | undefined => {
    const row = database
      .prepare(`
        SELECT id, value_json
          FROM facts current
         WHERE current.kind = 'commitment.snapshot'
           AND current.subject_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
           )
         LIMIT 1
      `)
      .get(`commitment:${commitmentId}`) as { id: string; value_json: string } | undefined;
    return row
      ? { id: row.id, value: JSON.parse(row.value_json) as Commitment }
      : undefined;
  };

  const appendCommitmentSnapshots = (snapshots: Commitment[]): void => {
    if (snapshots.length === 0) return;
    const commitmentId = snapshots[0]!.id;
    if (snapshots.some((snapshot) => snapshot.id !== commitmentId)) {
      throw new Error("One Commitment snapshot batch cannot contain multiple identities.");
    }
    const current = database
      .prepare(`
        SELECT id
          FROM facts current
         WHERE current.kind = 'commitment.snapshot'
           AND current.subject_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
           )
         LIMIT 1
      `)
      .get(`commitment:${commitmentId}`) as { id: string } | undefined;
    let predecessorId = current?.id;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const snapshot of snapshots) {
        const factId = randomUUID();
        const recordedAt = new Date().toISOString();
        database
          .prepare(`
            INSERT INTO facts (
              id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
            ) VALUES (?, ?, 'commitment.snapshot', ?, ?, ?)
          `)
          .run(
            factId,
            `commitment:${commitmentId}`,
            JSON.stringify(snapshot),
            predecessorId ?? null,
            recordedAt,
          );
        database
          .prepare(`
            INSERT INTO transitions (id, kind, fact_id, recorded_at)
            VALUES (?, ?, ?, ?)
          `)
          .run(randomUUID(), `commitment.${snapshot.state}`, factId, recordedAt);
        predecessorId = factId;
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const readLeadTurnAttemptRow = (
    attemptId: string,
  ): { id: string; value: LeadTurnAttempt } | undefined => {
    const row = database
      .prepare(`
        SELECT id, value_json
          FROM facts current
         WHERE current.kind = 'lead-turn-attempt.snapshot'
           AND current.subject_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
           )
         LIMIT 1
      `)
      .get(`lead-turn-attempt:${attemptId}`) as { id: string; value_json: string } | undefined;
    return row
      ? { id: row.id, value: JSON.parse(row.value_json) as LeadTurnAttempt }
      : undefined;
  };

  const appendLeadTurnAttemptSnapshots = (snapshots: LeadTurnAttempt[]): void => {
    if (snapshots.length === 0) return;
    const attemptId = snapshots[0]!.id;
    if (snapshots.some((snapshot) => snapshot.id !== attemptId)) {
      throw new Error("One Lead turn attempt snapshot batch cannot contain multiple identities.");
    }
    let predecessorId = readLeadTurnAttemptRow(attemptId)?.id;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const snapshot of snapshots) {
        const factId = randomUUID();
        const recordedAt = new Date().toISOString();
        database
          .prepare(`
            INSERT INTO facts (
              id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
            ) VALUES (?, ?, 'lead-turn-attempt.snapshot', ?, ?, ?)
          `)
          .run(
            factId,
            `lead-turn-attempt:${attemptId}`,
            JSON.stringify(snapshot),
            predecessorId ?? null,
            recordedAt,
          );
        database
          .prepare(`
            INSERT INTO transitions (id, kind, fact_id, recorded_at)
            VALUES (?, ?, ?, ?)
          `)
          .run(randomUUID(), `lead-turn-attempt.${snapshot.status}`, factId, recordedAt);
        predecessorId = factId;
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const readCurrentWorkerSnapshot = <T>(
    kind:
      | "worker-session.snapshot"
      | "worker-execution-attempt.snapshot"
      | "worker-question.snapshot"
      | "effect-intent.snapshot",
    subjectId: string,
  ): { id: string; value: T } | undefined => {
    const row = database
      .prepare(`
        SELECT id, value_json
          FROM facts current
         WHERE current.kind = ?
           AND current.subject_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
           )
         LIMIT 1
      `)
      .get(kind, subjectId) as { id: string; value_json: string } | undefined;
    return row ? { id: row.id, value: JSON.parse(row.value_json) as T } : undefined;
  };

  const readCurrentWorkerSnapshots = <T>(
    kind:
      | "worker-session.snapshot"
      | "worker-execution-attempt.snapshot"
      | "worker-question.snapshot",
  ): T[] => {
    const rows = database
      .prepare(`
        SELECT current.value_json
          FROM facts current
         WHERE current.kind = ?
           AND NOT EXISTS (
             SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
           )
         ORDER BY current.sequence
      `)
      .all(kind) as Array<{ value_json: string }>;
    return rows.map((row) => JSON.parse(row.value_json) as T);
  };

  type WorkerSnapshotEntry = {
    kind:
      | "worker-session.snapshot"
      | "worker-execution-attempt.snapshot"
      | "worker-question.snapshot"
      | "effect-intent.snapshot";
    subjectPrefix:
      | "worker-session"
      | "worker-execution-attempt"
      | "worker-question"
      | "effect-intent";
    transitionPrefix:
      | "worker-session"
      | "worker-execution-attempt"
      | "worker-question"
      | "effect-intent";
    snapshot: { id: string; state?: string; status?: string };
  };

  const appendWorkerStateBatch = (entries: WorkerSnapshotEntry[]): void => {
    if (entries.length === 0) return;
    const predecessorBySubject = new Map<string, string | undefined>();
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        const subjectId = `${entry.subjectPrefix}:${entry.snapshot.id}`;
        if (!predecessorBySubject.has(subjectId)) {
          predecessorBySubject.set(
            subjectId,
            readCurrentWorkerSnapshot(entry.kind, subjectId)?.id,
          );
        }
        const factId = randomUUID();
        const recordedAt = new Date().toISOString();
        database
          .prepare(`
            INSERT INTO facts (
              id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `)
          .run(
            factId,
            subjectId,
            entry.kind,
            JSON.stringify(entry.snapshot),
            predecessorBySubject.get(subjectId) ?? null,
            recordedAt,
          );
        database
          .prepare(`
            INSERT INTO transitions (id, kind, fact_id, recorded_at)
            VALUES (?, ?, ?, ?)
          `)
          .run(
            randomUUID(),
            `${entry.transitionPrefix}.${entry.snapshot.state ?? entry.snapshot.status}`,
            factId,
            recordedAt,
          );
        predecessorBySubject.set(subjectId, factId);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const appendWorkerSnapshots = <T extends { id: string; state?: string; status?: string }>(
    kind:
      | "worker-session.snapshot"
      | "worker-execution-attempt.snapshot"
      | "worker-question.snapshot",
    subjectPrefix: "worker-session" | "worker-execution-attempt" | "worker-question",
    transitionPrefix: "worker-session" | "worker-execution-attempt" | "worker-question",
    snapshots: T[],
  ): void => {
    if (snapshots.length === 0) return;
    const subjectIdentity = snapshots[0]!.id;
    if (snapshots.some((snapshot) => snapshot.id !== subjectIdentity)) {
      throw new Error("One Worker snapshot batch cannot contain multiple identities.");
    }
    appendWorkerStateBatch(
      snapshots.map((snapshot) => ({
        kind,
        subjectPrefix,
        transitionPrefix,
        snapshot,
      })),
    );
  };

  const readTargetProjectOperationAttemptRow = (
    attemptId: string,
  ): { id: string; value: TargetProjectOperationAttempt } | undefined => {
    const row = database
      .prepare(`
        SELECT id, value_json
          FROM facts current
         WHERE current.kind = 'target-project-operation-attempt.snapshot'
           AND current.subject_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
           )
         LIMIT 1
      `)
      .get(`target-project-operation-attempt:${attemptId}`) as
      | { id: string; value_json: string }
      | undefined;
    return row
      ? { id: row.id, value: JSON.parse(row.value_json) as TargetProjectOperationAttempt }
      : undefined;
  };

  const readEffectIntentRow = (
    effectIntentId: string,
  ): { id: string; value: EffectIntent } | undefined => {
    const row = database
      .prepare(`
        SELECT id, value_json
          FROM facts current
         WHERE current.kind = 'effect-intent.snapshot'
           AND current.subject_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
           )
         LIMIT 1
      `)
      .get(`effect-intent:${effectIntentId}`) as { id: string; value_json: string } | undefined;
    return row
      ? { id: row.id, value: JSON.parse(row.value_json) as EffectIntent }
      : undefined;
  };

  const writeOperationAndEffect = (
    attempt: TargetProjectOperationAttempt,
    effectIntent: TargetProjectOperationEffectIntent,
    predecessors?: { attemptId: string; effectIntentId: string },
    rejectConflictingCommitmentEffect = false,
  ): void => {
    if (
      attempt.effectIntentId !== effectIntent.id ||
      effectIntent.operationAttemptId !== attempt.id ||
      attempt.commitmentId !== effectIntent.commitmentId
    ) {
      throw new Error("Operation Attempt and effect intent attribution must match.");
    }
    const recordedAt = new Date().toISOString();
    const attemptFactId = randomUUID();
    const effectFactId = randomUUID();
    database.exec("BEGIN IMMEDIATE");
    try {
      if (rejectConflictingCommitmentEffect) {
        const conflict = database
          .prepare(`
            SELECT 1
              FROM facts current
             WHERE current.kind = 'effect-intent.snapshot'
                AND (
                  COALESCE(
                    json_extract(current.value_json, '$.authorizedWriteRootKey'),
                    lower(json_extract(current.value_json, '$.authorization.targetProjectPath'))
                  ) = ?
                  OR json_extract(current.value_json, '$.commitmentId') = ?
                )
               AND json_extract(current.value_json, '$.status') IN ('pending', 'dispatching', 'unknown')
               AND NOT EXISTS (
                 SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
               )
             LIMIT 1
          `)
          .get(effectIntent.authorizedWriteRootKey, effectIntent.commitmentId);
        if (conflict) {
          throw new Error("A conflicting Target Project effect is already open for this Commitment.");
        }
      }
      database
        .prepare(`
          INSERT INTO facts (
            id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
          ) VALUES (?, ?, 'target-project-operation-attempt.snapshot', ?, ?, ?)
        `)
        .run(
          attemptFactId,
          `target-project-operation-attempt:${attempt.id}`,
          JSON.stringify(attempt),
          predecessors?.attemptId ?? null,
          recordedAt,
        );
      database
        .prepare(`
          INSERT INTO transitions (id, kind, fact_id, recorded_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          `target-project-operation-attempt.${attempt.status}`,
          attemptFactId,
          recordedAt,
        );
      database
        .prepare(`
          INSERT INTO facts (
            id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
          ) VALUES (?, ?, 'effect-intent.snapshot', ?, ?, ?)
        `)
        .run(
          effectFactId,
          `effect-intent:${effectIntent.id}`,
          JSON.stringify(effectIntent),
          predecessors?.effectIntentId ?? null,
          recordedAt,
        );
      database
        .prepare(`
          INSERT INTO transitions (id, kind, fact_id, recorded_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(randomUUID(), `effect-intent.${effectIntent.status}`, effectFactId, recordedAt);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    storageStatus() {
      const row = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      if (row.journal_mode !== "wal") {
        throw new Error(`Authoritative state requires SQLite WAL; found ${row.journal_mode}.`);
      }
      return { journalMode: "wal" };
    },

    initialize(configuration) {
      validateConfiguration(configuration);
      const existing = readConfigurationRow();
      if (existing) {
        if (!sameConfiguration(existing.value, configuration)) {
          throw new Error("Authoritative state is already configured for a different Owner context.");
        }
        return;
      }
      appendFact(
        { kind: "owner.configuration", value: configuration },
        "owner.configuration-recorded",
      );
    },

    replaceOwnerConfiguration(configuration) {
      validateConfiguration(configuration);
      const existing = readConfigurationRow();
      if (!existing) throw new Error("Authoritative state is not configured.");
      appendFact(
        {
          kind: "owner.configuration",
          value: configuration,
        },
        "owner.model-policy-activated",
        existing.id,
      );
    },

    readOwnerConversation() {
      const configuration = readConfigurationRow()?.value;
      if (!configuration) return undefined;
      const rows = database
        .prepare(`
          SELECT ROW_NUMBER() OVER (ORDER BY sequence) AS sequence, id, kind, value_json
            FROM facts
           WHERE kind IN (
             'owner-conversation.owner-message',
             'owner-conversation.lead-agent-message'
           )
           ORDER BY sequence
        `)
        .all() as JournalRow[];
      const messages: ConversationMessage[] = rows.map((row) => {
        const value = JSON.parse(row.value_json) as {
          content: string;
          turnId: string;
          modelSelection: ModelSelection;
          modelPolicyRevision: string;
          selectionReason?: "fallback-after-ineligible-candidate";
        };
        if (row.kind === "owner-conversation.owner-message") {
          return {
            sequence: row.sequence,
            role: "owner",
            content: value.content,
            turnId: value.turnId,
            modelSelection: value.modelSelection,
            modelPolicyRevision: value.modelPolicyRevision,
            nativeHarness: null,
          };
        }
        return {
          sequence: row.sequence,
          role: "lead-agent",
          content: value.content,
          turnId: value.turnId,
          modelSelection: value.modelSelection,
          modelPolicyRevision: value.modelPolicyRevision,
          nativeHarness: null,
          ...(value.selectionReason ? { selectionReason: value.selectionReason } : {}),
        };
      });
      return { ...configuration, messages };
    },

    appendOwnerMessage(content) {
      const configuration = readConfigurationRow()?.value;
      if (!configuration) throw new Error("Authoritative state is not configured.");
      const turnId = randomUUID();
      appendFact(
        {
          kind: "owner-conversation.owner-message",
          value: {
            content,
            turnId,
            modelSelection: configuration.modelSelection,
            modelPolicyRevision: configuration.modelPolicyRevision,
          },
        },
        "owner-conversation.owner-message-recorded",
      );
      return turnId;
    },

    appendLeadAgentMessage(turnId, content, attribution) {
      const ownerTurn = database
        .prepare(`
          SELECT value_json
            FROM facts
           WHERE kind = 'owner-conversation.owner-message'
             AND json_extract(value_json, '$.turnId') = ?
           LIMIT 1
        `)
        .get(turnId) as { value_json: string } | undefined;
      if (!ownerTurn) throw new Error(`Unknown Lead turn ${turnId}.`);
      const existingResponse = database
        .prepare(`
          SELECT 1
            FROM facts
           WHERE kind = 'owner-conversation.lead-agent-message'
             AND json_extract(value_json, '$.turnId') = ?
           LIMIT 1
        `)
        .get(turnId);
      if (existingResponse) throw new Error(`Lead turn ${turnId} already has a response.`);
      const originalAttribution = JSON.parse(ownerTurn.value_json) as {
        modelSelection: ModelSelection;
        modelPolicyRevision: string;
      };
      appendFact(
        {
          kind: "owner-conversation.lead-agent-message",
          value: {
            content,
            turnId,
            modelSelection: attribution?.modelSelection ?? originalAttribution.modelSelection,
            modelPolicyRevision:
              attribution?.modelPolicyRevision ?? originalAttribution.modelPolicyRevision,
            ...(attribution?.selectionReason
              ? { selectionReason: attribution.selectionReason }
              : {}),
          },
        },
        "owner-conversation.lead-agent-message-recorded",
      );
    },

    ownerTurnSequence(turnId) {
      const row = database
        .prepare(`
          SELECT sequence
            FROM facts
           WHERE kind = 'owner-conversation.owner-message'
             AND json_extract(value_json, '$.turnId') = ?
           LIMIT 1
        `)
        .get(turnId) as { sequence: number } | undefined;
      return row?.sequence;
    },

    leadAgentResponse(ownerTurnId) {
      const row = database
        .prepare(`
          SELECT value_json
            FROM facts
           WHERE kind = 'owner-conversation.lead-agent-message'
             AND json_extract(value_json, '$.turnId') = ?
           LIMIT 1
        `)
        .get(ownerTurnId) as { value_json: string } | undefined;
      return row
        ? (JSON.parse(row.value_json) as { content: string }).content
        : undefined;
    },

    readCommitments() {
      const rows = database
        .prepare(`
          SELECT current.value_json
            FROM facts current
           WHERE current.kind = 'commitment.snapshot'
             AND NOT EXISTS (
               SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
             )
           ORDER BY current.sequence
        `)
        .all() as Array<{ value_json: string }>;
      return rows.map((row) => JSON.parse(row.value_json) as Commitment);
    },

    readCommitment(commitmentId) {
      return readCommitmentRow(commitmentId)?.value;
    },

    appendCommitmentSnapshots,

    appendLeadTurnAttemptSnapshots,

    readLeadTurnAttempt(attemptId) {
      return readLeadTurnAttemptRow(attemptId)?.value;
    },

    readLeadTurnAttempts() {
      const rows = database
        .prepare(`
          SELECT current.value_json
            FROM facts current
           WHERE current.kind = 'lead-turn-attempt.snapshot'
             AND NOT EXISTS (
               SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
             )
           ORDER BY current.sequence
        `)
        .all() as Array<{ value_json: string }>;
      return rows.map((row) => JSON.parse(row.value_json) as LeadTurnAttempt);
    },

    startWorkerExecution(workerSessionSnapshots, executionAttempt, effectIntent) {
      const workerSession = workerSessionSnapshots.at(-1);
      if (
        !workerSession ||
        workerSessionSnapshots.some((snapshot) => snapshot.id !== workerSession.id) ||
        executionAttempt.workerSessionId !== workerSession.id ||
        workerSession.currentExecutionAttemptId !== executionAttempt.id ||
        workerSession.state !== "starting" ||
        executionAttempt.status !== "launch-intent-recorded"
      ) {
        throw new Error("A Worker launch requires matching Session and attempt identities.");
      }
      if (
        effectIntent &&
        (effectIntent.kind !== "worker-assignment" ||
          effectIntent.workerSessionId !== workerSession.id ||
          effectIntent.executionAttemptId !== executionAttempt.id ||
          executionAttempt.effectIntentId !== effectIntent.id ||
          workerSession.assignment.readOnly ||
          effectIntent.status !== "pending")
      ) {
        throw new Error("An effectful Worker launch requires one matching pending effect intent.");
      }
      if (!effectIntent && !workerSession.assignment.readOnly) {
        throw new Error("An effectful Worker launch cannot omit its effect intent.");
      }
      const recordedAt = new Date().toISOString();
      let predecessorId = readCurrentWorkerSnapshot<WorkerSession>(
        "worker-session.snapshot",
        `worker-session:${workerSession.id}`,
      )?.id;
      database.exec("BEGIN IMMEDIATE");
      try {
        if (effectIntent) {
          const conflict = database
            .prepare(`
              SELECT 1
                FROM facts current
               WHERE current.kind = 'effect-intent.snapshot'
                 AND COALESCE(
                   json_extract(current.value_json, '$.authorizedWriteRootKey'),
                   lower(json_extract(current.value_json, '$.authorization.targetProjectPath'))
                 ) = ?
                 AND (
                   json_extract(current.value_json, '$.status') IN ('pending', 'dispatching', 'unknown')
                   OR (
                     json_extract(current.value_json, '$.kind') = 'worker-assignment'
                     AND json_extract(current.value_json, '$.status') = 'succeeded'
                     AND json_extract(current.value_json, '$.verificationOperationAttemptId') IS NULL
                   )
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
                 )
               LIMIT 1
            `)
            .get(effectIntent.authorizedWriteRootKey);
          if (conflict) {
            throw new Error("A conflicting Target Project effect is already open for this Authorized Write Root.");
          }
        }
        for (const snapshot of workerSessionSnapshots) {
          const factId = randomUUID();
          database
            .prepare(`
              INSERT INTO facts (
                id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
              ) VALUES (?, ?, 'worker-session.snapshot', ?, ?, ?)
            `)
            .run(
              factId,
              `worker-session:${snapshot.id}`,
              JSON.stringify(snapshot),
              predecessorId ?? null,
              recordedAt,
            );
          database
            .prepare(`
              INSERT INTO transitions (id, kind, fact_id, recorded_at)
              VALUES (?, ?, ?, ?)
            `)
            .run(randomUUID(), `worker-session.${snapshot.state}`, factId, recordedAt);
          predecessorId = factId;
        }
        const attemptFactId = randomUUID();
        database
          .prepare(`
            INSERT INTO facts (
              id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
            ) VALUES (?, ?, 'worker-execution-attempt.snapshot', ?, NULL, ?)
          `)
          .run(
            attemptFactId,
            `worker-execution-attempt:${executionAttempt.id}`,
            JSON.stringify(executionAttempt),
            recordedAt,
          );
        database
          .prepare(`
            INSERT INTO transitions (id, kind, fact_id, recorded_at)
            VALUES (?, 'worker-execution-attempt.launch-intent-recorded', ?, ?)
          `)
          .run(randomUUID(), attemptFactId, recordedAt);
        if (effectIntent) {
          const effectFactId = randomUUID();
          database
            .prepare(`
              INSERT INTO facts (
                id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
              ) VALUES (?, ?, 'effect-intent.snapshot', ?, NULL, ?)
            `)
            .run(
              effectFactId,
              `effect-intent:${effectIntent.id}`,
              JSON.stringify(effectIntent),
              recordedAt,
            );
          database
            .prepare(`
              INSERT INTO transitions (id, kind, fact_id, recorded_at)
              VALUES (?, 'effect-intent.pending', ?, ?)
            `)
            .run(randomUUID(), effectFactId, recordedAt);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    appendWorkerState(input) {
      appendWorkerStateBatch([
        ...(input.executionAttempt
          ? [
              {
                kind: "worker-execution-attempt.snapshot" as const,
                subjectPrefix: "worker-execution-attempt" as const,
                transitionPrefix: "worker-execution-attempt" as const,
                snapshot: input.executionAttempt,
              },
            ]
          : []),
        ...(input.questions ?? []).map((question) => ({
          kind: "worker-question.snapshot" as const,
          subjectPrefix: "worker-question" as const,
          transitionPrefix: "worker-question" as const,
          snapshot: question,
        })),
        ...(input.workerSession
          ? [
              {
                kind: "worker-session.snapshot" as const,
                subjectPrefix: "worker-session" as const,
                transitionPrefix: "worker-session" as const,
                snapshot: input.workerSession,
              },
            ]
          : []),
        ...(input.effectIntent
          ? [
              {
                kind: "effect-intent.snapshot" as const,
                subjectPrefix: "effect-intent" as const,
                transitionPrefix: "effect-intent" as const,
                snapshot: input.effectIntent,
              },
            ]
          : []),
      ]);
    },

    settleWorkerVerification(effectIntent, commitmentSnapshots) {
      const currentEffect = readEffectIntentRow(effectIntent.id);
      const commitment = commitmentSnapshots.at(-1);
      const currentCommitment = commitment ? readCommitmentRow(commitment.id) : undefined;
      if (
        currentEffect?.value.kind !== "worker-assignment" ||
        currentEffect.value.status !== "succeeded" ||
        currentEffect.value.verificationOperationAttemptId ||
        !effectIntent.verificationOperationAttemptId ||
        !commitment ||
        !currentCommitment ||
        commitmentSnapshots.some((snapshot) => snapshot.id !== commitment.id)
      ) {
        throw new Error("Worker Verification settlement requires current attributed state.");
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        const recordedAt = new Date().toISOString();
        const effectFactId = randomUUID();
        database
          .prepare(`
            INSERT INTO facts (
              id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
            ) VALUES (?, ?, 'effect-intent.snapshot', ?, ?, ?)
          `)
          .run(
            effectFactId,
            `effect-intent:${effectIntent.id}`,
            JSON.stringify(effectIntent),
            currentEffect.id,
            recordedAt,
          );
        database
          .prepare(`
            INSERT INTO transitions (id, kind, fact_id, recorded_at)
            VALUES (?, 'effect-intent.succeeded', ?, ?)
          `)
          .run(randomUUID(), effectFactId, recordedAt);
        let predecessorId = currentCommitment.id;
        for (const snapshot of commitmentSnapshots) {
          const factId = randomUUID();
          database
            .prepare(`
              INSERT INTO facts (
                id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
              ) VALUES (?, ?, 'commitment.snapshot', ?, ?, ?)
            `)
            .run(
              factId,
              `commitment:${snapshot.id}`,
              JSON.stringify(snapshot),
              predecessorId,
              recordedAt,
            );
          database
            .prepare(`
              INSERT INTO transitions (id, kind, fact_id, recorded_at)
              VALUES (?, ?, ?, ?)
            `)
            .run(randomUUID(), `commitment.${snapshot.state}`, factId, recordedAt);
          predecessorId = factId;
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    readCapabilityNotice(id) {
      return readCapabilityNoticeRow(id)?.value;
    },

    appendCapabilityNotice(notice) {
      const current = readCapabilityNoticeRow(notice.id);
      appendFact(
        { kind: "capability-notice.snapshot", value: notice },
        `capability-notice.${notice.state}`,
        current?.id,
      );
    },

    appendWorkerSessionSnapshots(snapshots) {
      appendWorkerSnapshots(
        "worker-session.snapshot",
        "worker-session",
        "worker-session",
        snapshots,
      );
    },

    readWorkerSession(workerSessionId) {
      return readCurrentWorkerSnapshot<WorkerSession>(
        "worker-session.snapshot",
        `worker-session:${workerSessionId}`,
      )?.value;
    },

    readWorkerSessions() {
      return readCurrentWorkerSnapshots<WorkerSession>("worker-session.snapshot");
    },

    appendWorkerExecutionAttemptSnapshots(snapshots) {
      appendWorkerSnapshots(
        "worker-execution-attempt.snapshot",
        "worker-execution-attempt",
        "worker-execution-attempt",
        snapshots,
      );
    },

    readWorkerExecutionAttempt(attemptId) {
      return readCurrentWorkerSnapshot<WorkerExecutionAttempt>(
        "worker-execution-attempt.snapshot",
        `worker-execution-attempt:${attemptId}`,
      )?.value;
    },

    readWorkerExecutionAttempts() {
      return readCurrentWorkerSnapshots<WorkerExecutionAttempt>(
        "worker-execution-attempt.snapshot",
      );
    },

    appendWorkerQuestionSnapshots(snapshots) {
      appendWorkerSnapshots(
        "worker-question.snapshot",
        "worker-question",
        "worker-question",
        snapshots,
      );
    },

    readWorkerQuestion(questionId) {
      return readCurrentWorkerSnapshot<WorkerQuestion>(
        "worker-question.snapshot",
        `worker-question:${questionId}`,
      )?.value;
    },

    readWorkerQuestions() {
      return readCurrentWorkerSnapshots<WorkerQuestion>("worker-question.snapshot");
    },

    startTargetProjectOperation(attempt, effectIntent) {
      if (
        readTargetProjectOperationAttemptRow(attempt.id) ||
        readEffectIntentRow(effectIntent.id)
      ) {
        throw new Error("Operation Attempt and effect intent identities must be new.");
      }
      const dispatching = attempt.status === "ready" && effectIntent.status === "pending";
      const rejected =
        (attempt.status === "rejected" || attempt.status === "unavailable") &&
        effectIntent.status === "rejected" &&
        attempt.result?.status === attempt.status;
      if (!dispatching && !rejected) {
        throw new Error("New operations must atomically record dispatch or discovery rejection.");
      }
      writeOperationAndEffect(attempt, effectIntent, undefined, true);
    },

    claimTargetProjectOperationDispatch(attempt, effectIntent) {
      const currentAttempt = readTargetProjectOperationAttemptRow(attempt.id);
      const currentEffect = readEffectIntentRow(effectIntent.id);
      if (!currentAttempt || !currentEffect) {
        throw new Error("Cannot claim an unknown Operation Attempt or effect intent.");
      }
      if (currentAttempt.value.status !== "ready" || currentEffect.value.status !== "pending") {
        throw new Error("Operation Attempt or effect intent is not ready for dispatch.");
      }
      if (attempt.status !== "running" || effectIntent.status !== "dispatching" || !effectIntent.lease) {
        throw new Error("Dispatch claim requires a running attempt and a durable effect lease.");
      }
      writeOperationAndEffect(attempt, effectIntent, {
        attemptId: currentAttempt.id,
        effectIntentId: currentEffect.id,
      });
    },

    settleTargetProjectOperation(attempt, effectIntent) {
      const currentAttempt = readTargetProjectOperationAttemptRow(attempt.id);
      const currentEffect = readEffectIntentRow(effectIntent.id);
      if (!currentAttempt || !currentEffect) {
        throw new Error("Cannot settle an unknown Operation Attempt or effect intent.");
      }
      const dispatched =
        currentAttempt.value.status === "running" && currentEffect.value.status === "dispatching";
      const undispatched =
        currentAttempt.value.status === "ready" &&
        currentEffect.value.status === "pending" &&
        attempt.status === "rejected" &&
        effectIntent.status === "rejected";
      if (!dispatched && !undispatched) {
        throw new Error("Operation Attempt or effect intent is already settled.");
      }
      writeOperationAndEffect(attempt, effectIntent, {
        attemptId: currentAttempt.id,
        effectIntentId: currentEffect.id,
      });
    },

    readTargetProjectOperationAttempt(attemptId) {
      return readTargetProjectOperationAttemptRow(attemptId)?.value;
    },

    readTargetProjectOperationAttempts() {
      const rows = database
        .prepare(`
          SELECT current.value_json
            FROM facts current
           WHERE current.kind = 'target-project-operation-attempt.snapshot'
             AND NOT EXISTS (
               SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
             )
           ORDER BY current.sequence
        `)
        .all() as Array<{ value_json: string }>;
      return rows.map((row) => JSON.parse(row.value_json) as TargetProjectOperationAttempt);
    },

    readEffectIntent(effectIntentId) {
      return readEffectIntentRow(effectIntentId)?.value;
    },

    readEffectIntents() {
      const rows = database
        .prepare(`
          SELECT current.value_json
            FROM facts current
           WHERE current.kind = 'effect-intent.snapshot'
             AND NOT EXISTS (
               SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
             )
           ORDER BY current.sequence
        `)
        .all() as Array<{ value_json: string }>;
      return rows.map((row) => JSON.parse(row.value_json) as EffectIntent);
    },

    reconcileEffectIntent(effectIntent) {
      const current = readEffectIntentRow(effectIntent.id);
      if (!current || current.value.status !== "unknown") {
        throw new Error("Only an uncertain effect can be reconciled.");
      }
      if (
        effectIntent.status !== "reconciled" ||
        !effectIntent.reconciliation ||
        !sameEffectIntentIdentityAndScope(current.value, effectIntent)
      ) {
        throw new Error("Effect reconciliation must preserve the original effect identity and scope.");
      }
      const recordedAt = new Date().toISOString();
      const factId = randomUUID();
      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .prepare(`
            INSERT INTO facts (
              id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
            ) VALUES (?, ?, 'effect-intent.snapshot', ?, ?, ?)
          `)
          .run(
            factId,
            `effect-intent:${effectIntent.id}`,
            JSON.stringify(effectIntent),
            current.id,
            recordedAt,
          );
        database
          .prepare(`
            INSERT INTO transitions (id, kind, fact_id, recorded_at)
            VALUES (?, 'effect-intent.reconciled', ?, ?)
          `)
          .run(randomUUID(), factId, recordedAt);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    readCommitmentHistory(commitmentId) {
      const rows = database
        .prepare(`
          SELECT sequence, value_json
            FROM facts
           WHERE kind = 'commitment.snapshot'
             AND subject_id = ?
           ORDER BY sequence
        `)
        .all(`commitment:${commitmentId}`) as Array<{
        sequence: number;
        value_json: string;
      }>;
      return rows.map((row) => ({
        sequence: row.sequence,
        commitment: JSON.parse(row.value_json) as Commitment,
      }));
    },

    async createBackup(databasePath) {
      if (!readConfigurationRow()) {
        throw new Error("An Authoritative State backup requires initialized CMD Riker state.");
      }
      const destination = resolve(databasePath);
      const liveDatabase = resolve(join(stateDirectory, "authoritative-state.sqlite"));
      if (destination === liveDatabase) {
        throw new Error("An Authoritative State backup cannot replace the live database.");
      }
      if (existsSync(destination) || existsSync(backupManifestPath(destination))) {
        throw new Error("An Authoritative State backup requires a new destination.");
      }
      mkdirSync(dirname(destination), { recursive: true });
      assertDatabaseIntegrity(database);
      const row = database.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM facts").get() as {
        sequence: number;
      };
      const identity = readStateIdentity(database);
      const backupId = randomUUID();
      const createdAt = new Date().toISOString();
      database
        .prepare(`
          INSERT INTO state_backups (id, state_id, write_generation, last_journal_sequence, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(backupId, identity.stateId, identity.writeGeneration, row.sequence, createdAt);
      await backupDatabase(database, destination);
      const manifest: AuthoritativeStateBackup = {
        version: 1,
        backupId,
        sourceStateId: identity.stateId,
        writeGeneration: identity.writeGeneration,
        databasePath: destination,
        sha256: sha256File(destination),
        createdAt,
        lastJournalSequence: row.sequence,
      };
      verifyCmdRikerBackupProvenance(destination, manifest);
      writeJsonAtomically(backupManifestPath(destination), manifest);
      return manifest;
    },

    close() {
      database.close();
    },
  };
}

export function openAuthoritativeStateSafely(
  stateDirectory: string,
): AuthoritativeStateOpenResult {
  mkdirSync(stateDirectory, { recursive: true });
  const activeRecovery = loadRecoveryStatus(stateDirectory);
  if (activeRecovery) return { kind: "recovery-required", recovery: activeRecovery };
  try {
    return { kind: "operational", state: openAuthoritativeState(stateDirectory) };
  } catch (error) {
    const recovery = preserveDamagedState(
      stateDirectory,
      error instanceof Error ? error.message : "SQLite integrity could not be established.",
    );
    return { kind: "recovery-required", recovery };
  }
}

export function restoreAuthoritativeStateBackup(input: {
  stateDirectory: string;
  backupPath: string;
  postBackupInventory: PostBackupEffectInventory;
}): AuthoritativeStateRecovery {
  const stateDirectory = resolve(input.stateDirectory);
  const recovery = loadRecoveryStatus(stateDirectory);
  if (!recovery) throw new Error("Authoritative State restore requires an active recovery.");
  validatePostBackupInventory(input.postBackupInventory);
  const backup = readVerifiedBackup(input.backupPath);
  const databasePath = resolve(join(stateDirectory, "authoritative-state.sqlite"));
  if (dirname(databasePath) !== stateDirectory) {
    throw new Error("Authoritative State restore target escaped its state directory.");
  }
  const restoreCandidate = join(stateDirectory, `restore-candidate-${randomUUID()}.sqlite`);
  copyFileSync(backup.databasePath, restoreCandidate);
  try {
    verifyDatabaseFile(restoreCandidate);
    const preserveSuffix = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    for (const fileName of [
      "authoritative-state.sqlite",
      "authoritative-state.sqlite-wal",
      "authoritative-state.sqlite-shm",
    ]) {
      const source = join(stateDirectory, fileName);
      if (existsSync(source)) {
        copyFileSync(
          source,
          join(recovery.damagedEvidenceDirectory, `pre-restore-${preserveSuffix}-${fileName}`),
        );
      }
    }
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    renameSync(restoreCandidate, databasePath);
  } catch (error) {
    rmSync(restoreCandidate, { force: true });
    throw error;
  }
  copyFileSync(
    backupManifestPath(backup.databasePath),
    join(recovery.damagedEvidenceDirectory, "restored-backup-manifest.json"),
  );
  const restored: AuthoritativeStateRecovery = {
    ...recovery,
    phase: "post-backup-reconciliation",
    reason:
      "A verified backup was restored; every possible later external effect must be reconciled before mutations resume.",
    restoredBackup: backup,
    postBackupInventory: input.postBackupInventory,
    postBackupReconciliations: [],
  };
  writeRecoveryStatus(stateDirectory, restored);
  return restored;
}

export function reconcilePostBackupEffect(input: {
  stateDirectory: string;
  effectId: string;
  disposition: PostBackupEffectReconciliation["disposition"];
  evidence: PostBackupEffectReconciliation["evidence"];
}): AuthoritativeStateRecovery {
  const stateDirectory = resolve(input.stateDirectory);
  const recovery = loadRecoveryStatus(stateDirectory);
  if (
    recovery?.phase !== "post-backup-reconciliation" ||
    !recovery.postBackupInventory ||
    !recovery.restoredBackup
  ) {
    throw new Error("Post-backup effect reconciliation requires a restored recovery state.");
  }
  const effect = recovery.postBackupInventory.effects.find((candidate) => candidate.id === input.effectId);
  if (!effect) throw new Error(`Unknown post-backup effect ${input.effectId}.`);
  if (recovery.postBackupReconciliations?.some((item) => item.effectId === input.effectId)) {
    throw new Error(`Post-backup effect ${input.effectId} is already reconciled.`);
  }
  assertEffectEvidenceSupportsDisposition(input.disposition, input.evidence);
  const updated: AuthoritativeStateRecovery = {
    ...recovery,
    postBackupReconciliations: [
      ...(recovery.postBackupReconciliations ?? []),
      {
        effectId: effect.id,
        disposition: input.disposition,
        evidence: input.evidence,
        reconciledAt: new Date().toISOString(),
        reconciledBy: "lead-agent",
      },
    ],
  };
  writeRecoveryStatus(stateDirectory, updated);
  return updated;
}

export function completeAuthoritativeStateRecovery(stateDirectoryInput: string): void {
  const stateDirectory = resolve(stateDirectoryInput);
  const recovery = loadRecoveryStatus(stateDirectory);
  if (
    recovery?.phase !== "post-backup-reconciliation" ||
    !recovery.postBackupInventory ||
    !recovery.restoredBackup
  ) {
    throw new Error("Authoritative State recovery is not ready for completion.");
  }
  const reconciled = new Set(
    (recovery.postBackupReconciliations ?? []).map((item) => item.effectId),
  );
  const unresolved = recovery.postBackupInventory.effects.find((effect) => !reconciled.has(effect.id));
  if (unresolved) {
    throw new Error(
      `Post-backup effect ${unresolved.id} requires external evidence before recovery can complete.`,
    );
  }
  verifyCmdRikerBackupProvenance(
    join(stateDirectory, "authoritative-state.sqlite"),
    recovery.restoredBackup,
  );
  writeJsonAtomically(
    join(recovery.damagedEvidenceDirectory, "completed-recovery.json"),
    { ...recovery, completedAt: new Date().toISOString(), mutationPolicy: "enabled" },
  );
  rmSync(recoveryStatusPath(stateDirectory), { force: true });
}

export function establishNewAuthoritativeStateBaseline(input: {
  stateDirectory: string;
  configuration: OwnerConfiguration;
  ownerConfirmation: string;
}): void {
  const stateDirectory = resolve(input.stateDirectory);
  const recovery = loadRecoveryStatus(stateDirectory);
  if (!recovery) throw new Error("A new baseline requires an active Authoritative State recovery.");
  if (input.ownerConfirmation !== "ESTABLISH-NEW-BASELINE") {
    throw new Error("A new baseline requires explicit Owner confirmation.");
  }
  const candidateDirectory = resolve(join(stateDirectory, `baseline-candidate-${randomUUID()}`));
  if (dirname(candidateDirectory) !== stateDirectory) {
    throw new Error("New baseline candidate escaped its state directory.");
  }
  mkdirSync(candidateDirectory, { recursive: true });
  try {
    const candidateState = openAuthoritativeState(candidateDirectory);
    try {
      candidateState.initialize(input.configuration);
    } finally {
      candidateState.close();
    }
    const candidateDatabase = join(candidateDirectory, "authoritative-state.sqlite");
    verifyDatabaseFile(candidateDatabase);
    const databasePath = join(stateDirectory, "authoritative-state.sqlite");
    const preserveSuffix = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    for (const fileName of [
      "authoritative-state.sqlite",
      "authoritative-state.sqlite-wal",
      "authoritative-state.sqlite-shm",
    ]) {
      const source = join(stateDirectory, fileName);
      if (existsSync(source)) {
        copyFileSync(
          source,
          join(recovery.damagedEvidenceDirectory, `pre-new-baseline-${preserveSuffix}-${fileName}`),
        );
      }
    }
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
    renameSync(candidateDatabase, databasePath);
    writeJsonAtomically(
      join(recovery.damagedEvidenceDirectory, "completed-recovery.json"),
      {
        ...recovery,
        completedAt: new Date().toISOString(),
        mutationPolicy: "enabled",
        completion: "owner-established-new-baseline",
        ownerConfirmation: input.ownerConfirmation,
      },
    );
    rmSync(recoveryStatusPath(stateDirectory), { force: true });
  } finally {
    rmSync(candidateDirectory, { recursive: true, force: true });
  }
}

function assertDatabaseIntegrity(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA integrity_check").all() as Array<{
    integrity_check: string;
  }>;
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    const detail = rows.map((row) => row.integrity_check).join("; ");
    throw new Error(`SQLite integrity check failed${detail ? `: ${detail}` : "."}`);
  }
}

function verifyDatabaseFile(databasePath: string): void {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assertDatabaseIntegrity(database);
  } finally {
    database.close();
  }
}

function readVerifiedBackup(databasePathInput: string): AuthoritativeStateBackup {
  const databasePath = resolve(databasePathInput);
  const manifestPath = backupManifestPath(databasePath);
  if (!existsSync(databasePath) || !existsSync(manifestPath)) {
    throw new Error("Restore requires a CMD Riker backup and its integrity manifest.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AuthoritativeStateBackup;
  if (
    manifest.version !== 1 ||
    typeof manifest.backupId !== "string" ||
    !manifest.backupId.trim() ||
    typeof manifest.sourceStateId !== "string" ||
    !manifest.sourceStateId.trim() ||
    !Number.isInteger(manifest.writeGeneration) ||
    manifest.writeGeneration < 1 ||
    !Number.isInteger(manifest.lastJournalSequence) ||
    manifest.lastJournalSequence < 0 ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    resolve(manifest.databasePath) !== databasePath ||
    manifest.sha256 !== sha256File(databasePath)
  ) {
    throw new Error("Authoritative State backup integrity verification failed.");
  }
  verifyCmdRikerBackupProvenance(databasePath, manifest);
  return { ...manifest, databasePath };
}

function readStateIdentity(database: DatabaseSync): {
  stateId: string;
  writeGeneration: number;
} {
  const row = database
    .prepare(`
      SELECT state_id AS stateId, write_generation AS writeGeneration
        FROM state_identity
       WHERE singleton = 1
    `)
    .get() as { stateId: string; writeGeneration: number } | undefined;
  if (!row) throw new Error("CMD Riker Authoritative State identity is missing.");
  return row;
}

function verifyCmdRikerBackupProvenance(
  databasePath: string,
  manifest: AuthoritativeStateBackup,
): void {
  if (sha256File(databasePath) !== manifest.sha256) {
    throw new Error("CMD Riker backup hash does not match the installed recovery database.");
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assertDatabaseIntegrity(database);
    const identity = readStateIdentity(database);
    const backup = database
      .prepare(`
        SELECT state_id AS stateId,
               write_generation AS writeGeneration,
               last_journal_sequence AS lastJournalSequence,
               created_at AS createdAt
          FROM state_backups
         WHERE id = ?
      `)
      .get(manifest.backupId) as {
      stateId: string;
      writeGeneration: number;
      lastJournalSequence: number;
      createdAt: string;
    } | undefined;
    const journal = database
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM facts")
      .get() as { sequence: number };
    const configuration = database
      .prepare("SELECT 1 FROM facts WHERE kind = 'owner.configuration' LIMIT 1")
      .get();
    if (
      !configuration ||
      identity.stateId !== manifest.sourceStateId ||
      identity.writeGeneration !== manifest.writeGeneration ||
      !backup ||
      backup.stateId !== manifest.sourceStateId ||
      backup.writeGeneration !== manifest.writeGeneration ||
      backup.lastJournalSequence !== manifest.lastJournalSequence ||
      backup.createdAt !== manifest.createdAt ||
      journal.sequence !== manifest.lastJournalSequence
    ) {
      throw new Error("CMD Riker backup provenance does not match its embedded state lineage.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CMD Riker backup provenance")) {
      throw error;
    }
    throw new Error(
      `CMD Riker backup provenance or schema verification failed: ${
        error instanceof Error ? error.message : "unknown verification failure"
      }`,
    );
  } finally {
    database.close();
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function backupManifestPath(databasePath: string): string {
  return `${databasePath}.manifest.json`;
}

function validatePostBackupInventory(inventory: PostBackupEffectInventory): void {
  if (
    inventory.source !== "external-effect-inventory" ||
    !Number.isFinite(Date.parse(inventory.assessedAt)) ||
    !inventory.reference.trim() ||
    !inventory.summary.trim() ||
    inventory.completenessEvidence?.source !==
      "write-generation-and-effect-inventory-readback"
  ) {
    throw new Error(
      "Restore requires external evidence that the post-backup effect inventory is complete.",
    );
  }
  assertExternalEffectEvidence(inventory.completenessEvidence);
  const identities = new Set<string>();
  for (const effect of inventory.effects) {
    if (
      !effect.id.trim() ||
      !effect.scope.trim() ||
      !effect.expectedEffect.trim() ||
      identities.has(effect.id)
    ) {
      throw new Error("Post-backup effect inventory requires unique attributed effects.");
    }
    identities.add(effect.id);
  }
}

function preserveDamagedState(
  stateDirectory: string,
  reason: string,
): AuthoritativeStateRecovery {
  const detectedAt = new Date().toISOString();
  const damagedEvidenceDirectory = join(
    stateDirectory,
    "recovery-evidence",
    `${detectedAt.replaceAll(":", "-")}-${randomUUID()}`,
  );
  mkdirSync(damagedEvidenceDirectory, { recursive: true });
  for (const fileName of [
    "authoritative-state.sqlite",
    "authoritative-state.sqlite-wal",
    "authoritative-state.sqlite-shm",
  ]) {
    const source = join(stateDirectory, fileName);
    if (existsSync(source)) copyFileSync(source, join(damagedEvidenceDirectory, fileName));
  }
  const recovery: AuthoritativeStateRecovery = {
    version: 1,
    phase: "damaged-state",
    mutationPolicy: "disabled",
    reason,
    detectedAt,
    damagedEvidenceDirectory,
  };
  writeRecoveryStatus(stateDirectory, recovery);
  return recovery;
}

function loadRecoveryStatus(stateDirectory: string): AuthoritativeStateRecovery | undefined {
  const path = recoveryStatusPath(stateDirectory);
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecoveryStatus(value)) throw new Error("Recovery marker shape is invalid.");
    return value;
  } catch (error) {
    return preserveDamagedRecoveryMarker(
      stateDirectory,
      path,
      error instanceof Error ? error.message : "Recovery marker could not be read.",
    );
  }
}

function writeRecoveryStatus(
  stateDirectory: string,
  recovery: AuthoritativeStateRecovery,
): void {
  writeJsonAtomically(recoveryStatusPath(stateDirectory), recovery);
}

function recoveryStatusPath(stateDirectory: string): string {
  return join(stateDirectory, "authoritative-state-recovery.json");
}

function preserveDamagedRecoveryMarker(
  stateDirectory: string,
  markerPath: string,
  detail: string,
): AuthoritativeStateRecovery {
  const detectedAt = new Date().toISOString();
  const damagedEvidenceDirectory = join(
    stateDirectory,
    "recovery-evidence",
    `${detectedAt.replaceAll(":", "-")}-${randomUUID()}`,
  );
  mkdirSync(damagedEvidenceDirectory, { recursive: true });
  copyFileSync(markerPath, join(damagedEvidenceDirectory, "damaged-authoritative-state-recovery.json"));
  for (const fileName of [
    "authoritative-state.sqlite",
    "authoritative-state.sqlite-wal",
    "authoritative-state.sqlite-shm",
  ]) {
    const source = join(stateDirectory, fileName);
    if (existsSync(source)) copyFileSync(source, join(damagedEvidenceDirectory, fileName));
  }
  const recovery: AuthoritativeStateRecovery = {
    version: 1,
    phase: "damaged-state",
    mutationPolicy: "disabled",
    reason: `Recovery metadata integrity failed: ${detail}`,
    detectedAt,
    damagedEvidenceDirectory,
  };
  writeRecoveryStatus(stateDirectory, recovery);
  return recovery;
}

function isRecoveryStatus(value: unknown): value is AuthoritativeStateRecovery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<AuthoritativeStateRecovery>;
  return (
    candidate.version === 1 &&
    (candidate.phase === "damaged-state" || candidate.phase === "post-backup-reconciliation") &&
    candidate.mutationPolicy === "disabled" &&
    typeof candidate.reason === "string" &&
    typeof candidate.detectedAt === "string" &&
    typeof candidate.damagedEvidenceDirectory === "string"
  );
}

function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx");
    writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function ensureSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      subject_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'owner.configuration',
        'owner-conversation.owner-message',
        'owner-conversation.lead-agent-message',
        'commitment.snapshot',
        'lead-turn-attempt.snapshot',
        'worker-session.snapshot',
        'worker-execution-attempt.snapshot',
        'worker-question.snapshot',
        'capability-notice.snapshot',
        'target-project-operation-attempt.snapshot',
        'effect-intent.snapshot'
      )),
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),
      supersedes_fact_id TEXT REFERENCES facts(id),
      recorded_at TEXT NOT NULL
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS facts_one_successor
      ON facts(supersedes_fact_id) WHERE supersedes_fact_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS transitions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN (
        'owner.configuration-recorded',
        'owner.model-policy-activated',
        'owner-conversation.owner-message-recorded',
        'owner-conversation.lead-agent-message-recorded',
        'commitment.committed',
        'commitment.ready',
        'commitment.active',
        'commitment.verifying',
        'commitment.awaiting-acceptance',
        'commitment.accepted',
        'commitment.cancelled',
        'commitment.superseded',
        'lead-turn-attempt.started',
        'lead-turn-attempt.completed',
        'lead-turn-attempt.failed',
        'worker-session.starting',
        'worker-session.running',
        'worker-session.waiting-question',
        'worker-session.cancellation-requested',
        'worker-session.reconciling',
        'worker-session.completed',
        'worker-session.blocked',
        'worker-session.failed',
        'worker-session.cancelled',
        'worker-execution-attempt.starting',
        'worker-execution-attempt.launch-intent-recorded',
        'worker-execution-attempt.dispatching',
        'worker-execution-attempt.running',
        'worker-execution-attempt.completed',
        'worker-execution-attempt.blocked',
        'worker-execution-attempt.failed',
        'worker-execution-attempt.cancelled',
        'worker-execution-attempt.timed-out',
        'worker-execution-attempt.continuity-lost',
        'worker-question.open',
        'worker-question.answer-recorded',
        'worker-question.delivered',
        'worker-question.cancelled',
        'capability-notice.active',
        'capability-notice.cleared',
        'target-project-operation-attempt.running',
        'target-project-operation-attempt.ready',
        'target-project-operation-attempt.succeeded',
        'target-project-operation-attempt.failed',
        'target-project-operation-attempt.timed-out',
        'target-project-operation-attempt.unknown',
        'target-project-operation-attempt.rejected',
        'target-project-operation-attempt.unavailable',
        'effect-intent.dispatching',
        'effect-intent.pending',
        'effect-intent.succeeded',
        'effect-intent.unknown',
        'effect-intent.rejected',
        'effect-intent.reconciled'
      )),
      fact_id TEXT NOT NULL UNIQUE REFERENCES facts(id),
      recorded_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS state_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state_id TEXT NOT NULL UNIQUE,
      write_generation INTEGER NOT NULL CHECK (write_generation > 0)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS state_backups (
      id TEXT PRIMARY KEY,
      state_id TEXT NOT NULL,
      write_generation INTEGER NOT NULL CHECK (write_generation > 0),
      last_journal_sequence INTEGER NOT NULL CHECK (last_journal_sequence >= 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY (state_id) REFERENCES state_identity(state_id)
    ) STRICT;
  `);
  database
    .prepare(`
      INSERT OR IGNORE INTO state_identity (singleton, state_id, write_generation)
      VALUES (1, ?, 1)
    `)
    .run(randomUUID());
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'facts'")
    .get() as { sql: string };
  const transitionsRow = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transitions'")
    .get() as { sql: string };
  if (
    row.sql.includes("'commitment.snapshot'") &&
    row.sql.includes("'lead-turn-attempt.snapshot'") &&
    row.sql.includes("'worker-session.snapshot'") &&
    row.sql.includes("'worker-execution-attempt.snapshot'") &&
    row.sql.includes("'worker-question.snapshot'") &&
    row.sql.includes("'capability-notice.snapshot'") &&
    row.sql.includes("'target-project-operation-attempt.snapshot'") &&
    row.sql.includes("'effect-intent.snapshot'") &&
    transitionsRow.sql.includes("'worker-execution-attempt.timed-out'") &&
    transitionsRow.sql.includes("'effect-intent.reconciled'")
  ) {
    return;
  }

  database.exec("PRAGMA foreign_keys = OFF;");
  try {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE facts RENAME TO facts_legacy;
      ALTER TABLE transitions RENAME TO transitions_legacy;
      DROP INDEX facts_one_successor;

      CREATE TABLE facts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        subject_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'owner.configuration',
          'owner-conversation.owner-message',
          'owner-conversation.lead-agent-message',
          'commitment.snapshot',
          'lead-turn-attempt.snapshot',
          'worker-session.snapshot',
          'worker-execution-attempt.snapshot',
          'worker-question.snapshot',
          'capability-notice.snapshot',
          'target-project-operation-attempt.snapshot',
          'effect-intent.snapshot'
        )),
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        supersedes_fact_id TEXT REFERENCES facts(id),
        recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX facts_one_successor
        ON facts(supersedes_fact_id) WHERE supersedes_fact_id IS NOT NULL;
      CREATE TABLE transitions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN (
          'owner.configuration-recorded',
          'owner.model-policy-activated',
          'owner-conversation.owner-message-recorded',
          'owner-conversation.lead-agent-message-recorded',
          'commitment.committed',
          'commitment.ready',
          'commitment.active',
          'commitment.verifying',
          'commitment.awaiting-acceptance',
          'commitment.accepted',
          'commitment.cancelled',
          'commitment.superseded',
          'lead-turn-attempt.started',
          'lead-turn-attempt.completed',
          'lead-turn-attempt.failed',
          'worker-session.starting',
          'worker-session.running',
          'worker-session.waiting-question',
          'worker-session.cancellation-requested',
          'worker-session.reconciling',
          'worker-session.completed',
          'worker-session.blocked',
          'worker-session.failed',
          'worker-session.cancelled',
          'worker-execution-attempt.starting',
          'worker-execution-attempt.launch-intent-recorded',
          'worker-execution-attempt.dispatching',
          'worker-execution-attempt.running',
          'worker-execution-attempt.completed',
          'worker-execution-attempt.blocked',
          'worker-execution-attempt.failed',
          'worker-execution-attempt.cancelled',
          'worker-execution-attempt.timed-out',
          'worker-execution-attempt.continuity-lost',
          'worker-question.open',
          'worker-question.answer-recorded',
          'worker-question.delivered',
          'worker-question.cancelled',
          'capability-notice.active',
          'capability-notice.cleared',
          'target-project-operation-attempt.running',
          'target-project-operation-attempt.ready',
          'target-project-operation-attempt.succeeded',
          'target-project-operation-attempt.failed',
          'target-project-operation-attempt.timed-out',
          'target-project-operation-attempt.unknown',
          'target-project-operation-attempt.rejected',
          'target-project-operation-attempt.unavailable',
          'effect-intent.dispatching',
          'effect-intent.pending',
          'effect-intent.succeeded',
          'effect-intent.unknown',
          'effect-intent.rejected',
          'effect-intent.reconciled'
        )),
        fact_id TEXT NOT NULL UNIQUE REFERENCES facts(id),
        recorded_at TEXT NOT NULL
      ) STRICT;

      INSERT INTO facts
        SELECT sequence, id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
          FROM facts_legacy;
      INSERT INTO transitions
        SELECT id, kind, fact_id, recorded_at FROM transitions_legacy;
      DROP TABLE transitions_legacy;
      DROP TABLE facts_legacy;
      COMMIT;
    `);
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
}

function parseConfiguration(valueJson: string): OwnerConfiguration {
  const value = JSON.parse(valueJson) as OwnerConfiguration;
  return {
    targetProject: value.targetProject,
    modelSelection: value.modelSelection,
    ...(Array.isArray(value.modelFallbacks) ? { modelFallbacks: value.modelFallbacks } : {}),
    ...(value.modelRequirements ? { modelRequirements: value.modelRequirements } : {}),
    modelPolicyRevision: value.modelPolicyRevision,
    ...(value.workerModelPolicy ? { workerModelPolicy: value.workerModelPolicy } : {}),
  };
}

function validateConfiguration(configuration: OwnerConfiguration): void {
  assertSupportedModelSelection(configuration.modelSelection);
  for (const fallback of configuration.modelFallbacks ?? []) {
    assertSupportedModelSelection(fallback);
  }
  if (configuration.workerModelPolicy) {
    const { revision, selection } = configuration.workerModelPolicy;
    if (!revision.trim()) throw new Error("Worker Model Policy revision is required.");
    assertSupportedWorkerModelSelection(selection);
  }
}

function sameEffectIntentIdentityAndScope(left: EffectIntent, right: EffectIntent): boolean {
  if (
    left.id !== right.id ||
    left.kind !== right.kind ||
    left.commitmentId !== right.commitmentId ||
    left.expectedEffect !== right.expectedEffect ||
    left.authorizedWriteRootKey !== right.authorizedWriteRootKey ||
    left.retryRule !== right.retryRule ||
    left.authorization.kind !== right.authorization.kind ||
    left.authorization.commitmentId !== right.authorization.commitmentId ||
    left.authorization.targetProjectPath !== right.authorization.targetProjectPath ||
    left.authorization.validatedAt !== right.authorization.validatedAt ||
    JSON.stringify(left.lease) !== JSON.stringify(right.lease)
  ) {
    return false;
  }
  if (left.kind === "target-project-operation") {
    return (
      right.kind === "target-project-operation" &&
      left.operationAttemptId === right.operationAttemptId &&
      JSON.stringify(left.causedByWorker) === JSON.stringify(right.causedByWorker)
    );
  }
  return (
    right.kind === "worker-assignment" &&
    left.workerSessionId === right.workerSessionId &&
    left.executionAttemptId === right.executionAttemptId &&
    left.verificationOperationAttemptId === right.verificationOperationAttemptId
  );
}

function factSubject(input: FactDraft): string {
  switch (input.kind) {
    case "owner.configuration":
      return "owner:primary";
    case "owner-conversation.owner-message":
    case "owner-conversation.lead-agent-message":
      return "owner-conversation:primary";
    case "commitment.snapshot":
      return `commitment:${input.value.id}`;
    case "lead-turn-attempt.snapshot":
      return `lead-turn-attempt:${input.value.id}`;
    case "worker-session.snapshot":
      return `worker-session:${input.value.id}`;
    case "worker-execution-attempt.snapshot":
      return `worker-execution-attempt:${input.value.id}`;
    case "worker-question.snapshot":
      return `worker-question:${input.value.id}`;
    case "capability-notice.snapshot":
      return `capability-notice:${input.value.id}`;
    case "target-project-operation-attempt.snapshot":
      return `target-project-operation-attempt:${input.value.id}`;
    case "effect-intent.snapshot":
      return `effect-intent:${input.value.id}`;
  }
}

function sameConfiguration(left: OwnerConfiguration, right: OwnerConfiguration): boolean {
  return (
    left.targetProject.path === right.targetProject.path &&
    sameSelection(left.modelSelection, right.modelSelection) &&
    sameSelectionList(left.modelFallbacks ?? [], right.modelFallbacks ?? []) &&
    JSON.stringify(left.modelRequirements) === JSON.stringify(right.modelRequirements) &&
    left.modelPolicyRevision === right.modelPolicyRevision &&
    JSON.stringify(left.workerModelPolicy) === JSON.stringify(right.workerModelPolicy)
  );
}

function sameSelectionList(left: ModelSelection[], right: ModelSelection[]): boolean {
  return (
    left.length === right.length &&
    left.every((selection, index) => sameSelection(selection, right[index]))
  );
}

function sameSelection(left: ModelSelection, right: ModelSelection | undefined): boolean {
  if (!right) return false;
  if (
    left.provider !== right.provider ||
    left.model !== right.model ||
    left.api !== right.api
  ) {
    return false;
  }
  return (
    left.api !== "openai-completions" ||
    (right.api === "openai-completions" && left.baseUrl === right.baseUrl)
  );
}
