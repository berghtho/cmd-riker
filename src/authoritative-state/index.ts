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
  type ActingAuthority,
  type ActingAuthorityEffectRequest,
  assertSupportedWorkerModelSelection,
  type CapabilityNotice,
  type Commitment,
  type CoordinationMessage,
  type LeadTurnAttempt,
  type OwnerConfiguration,
  type StandingOrder,
  type WorkerExecutionAttempt,
  type WorkerQuestion,
  type WorkerSession,
} from "../orchestration-core/index.ts";
import {
  assertEffectEvidenceSupportsDisposition,
  assertExternalEffectEvidence,
} from "../target-project-operations/index.ts";
import type { SelfRepairRecord } from "../self-repair-controller/index.ts";
import type {
  ForgeOperationAttempt,
  ForgeOwnerActionNotice,
} from "../forge-operations/index.ts";
import type {
  EffectIntent,
  ExternalEffectEvidence,
  ForgeOperationEffectIntent,
  TargetProjectOperationEffectIntent,
  TargetProjectOperationAttempt,
  WorkerAssignmentEffectIntent,
} from "../target-project-operations/index.ts";
import {
  assertWriteGeneration,
  authoritativeStateSchemaRevision,
  ensureWriteGenerationSchema,
  readWriteGenerationHighWater,
  readWriteGeneration,
  recordWriteGenerationHighWater,
  StaleWriteGenerationError,
} from "../write-generation.ts";

export { StaleWriteGenerationError };

export type { ModelSelection } from "../model-selection.ts";
export type { SelfRepairRecord } from "../self-repair-controller/index.ts";
export type {
  ActingAuthority,
  ActingAuthorityEffectRequest,
  ActingAuthorityEvent,
  ActingAuthorityHandoff,
  CapabilityNotice,
  Commitment,
  CommitmentCriterion,
  CommitmentDraft,
  CommitmentState,
  CoordinationMessage,
  LeadModelPolicy,
  LeadTurnAttempt,
  ModelCandidateValidation,
  OwnerConfiguration,
  StandingOrder,
  StandingOrderDraft,
  StandingOrderEffectClass,
  ReviewFinding,
  ReviewReason,
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
  failedWriteGeneration?: number;
  restoredBackup?: AuthoritativeStateBackup;
  restoredWriteGeneration?: number;
  restoredDatabaseSha256?: string;
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
  lifecycleStatus(): {
    schemaRevision: number;
    writeGeneration: number;
    journalMode: "wal";
    integrity: "passed";
  };
  probeLifecycle(nonce: string): void;
  initialize(configuration: OwnerConfiguration): void;
  replaceOwnerConfiguration(configuration: OwnerConfiguration): void;
  readOwnerConversation(): OwnerConversation | undefined;
  ownerMessage(ownerTurnId: string): string | undefined;
  latestOwnerTurnId(): string | undefined;
  leadAgentResponse(ownerTurnId: string): string | undefined;
  appendOwnerMessage(content: string): string;
  recordOwnerInteractionDisposition(
    ownerTurnId: string,
    kind: "session-view-control",
  ): void;
  ownerInteractionDisposition(ownerTurnId: string): "session-view-control" | undefined;
  appendLeadAgentMessage(
    turnId: string,
    content: string,
    attribution?: {
      modelSelection: ModelSelection;
      modelPolicyRevision: string;
      selectionReason?: "fallback-after-ineligible-candidate";
    },
  ): void;
  appendLeadAgentMessageWithAccounts(
    turnId: string,
    content: string,
    accounts: {
      selfRepairs: SelfRepairRecord[];
      commitments: Commitment[];
    },
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
  transitionExecutionCheckout(input: {
    workerSession: WorkerSession;
    executionAttempt?: WorkerExecutionAttempt;
    commitmentSnapshots?: Commitment[];
  }): void;
  settleWorkerVerification(
    effectIntent: WorkerAssignmentEffectIntent,
    commitmentSnapshots: Commitment[],
  ): void;
  readCapabilityNotice(id: CapabilityNotice["id"]): CapabilityNotice | undefined;
  appendCapabilityNotice(notice: CapabilityNotice): void;
  readStandingOrder(standingOrderId: string): StandingOrder | undefined;
  readStandingOrders(): StandingOrder[];
  appendStandingOrderSnapshots(snapshots: StandingOrder[]): void;
  readActingAuthority(actingAuthorityId: string): ActingAuthority | undefined;
  readActingAuthorities(): ActingAuthority[];
  appendActingAuthoritySnapshots(snapshots: ActingAuthority[]): void;
  appendSelfRepairSnapshots(snapshots: SelfRepairRecord[]): void;
  readSelfRepair(selfRepairId: string): SelfRepairRecord | undefined;
  readSelfRepairs(): SelfRepairRecord[];
  appendCoordinationMessage(message: CoordinationMessage): void;
  readCoordinationMessages(): CoordinationMessage[];
  appendForgeOperationAttemptSnapshots(snapshots: ForgeOperationAttempt[]): void;
  readForgeOperationAttempt(attemptId: string): ForgeOperationAttempt | undefined;
  readForgeOperationAttempts(): ForgeOperationAttempt[];
  startForgeMutation(
    attempt: ForgeOperationAttempt,
    effectIntent: ForgeOperationEffectIntent,
  ): void;
  claimForgeMutation(
    attempt: ForgeOperationAttempt,
    effectIntent: ForgeOperationEffectIntent,
  ): void;
  settleForgeMutation(
    attempt: ForgeOperationAttempt,
    effectIntent: ForgeOperationEffectIntent,
  ): void;
  readForgeOwnerActionNotice(id: ForgeOwnerActionNotice["id"]): ForgeOwnerActionNotice | undefined;
  readForgeOwnerActionNotices(): ForgeOwnerActionNotice[];
  appendForgeOwnerActionNotice(notice: ForgeOwnerActionNotice): void;
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
  | { kind: "standing-order.snapshot"; value: StandingOrder }
  | { kind: "acting-authority.snapshot"; value: ActingAuthority }
  | { kind: "self-repair.snapshot"; value: SelfRepairRecord }
  | { kind: "coordination-message.recorded"; value: CoordinationMessage }
  | { kind: "forge-operation-attempt.snapshot"; value: ForgeOperationAttempt }
  | { kind: "forge-owner-action-notice.snapshot"; value: ForgeOwnerActionNotice }
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
  | "owner.forge-authorities-reconfigured"
  | "owner-conversation.owner-message-recorded"
  | "owner-conversation.lead-agent-message-recorded"
  | `commitment.${Commitment["state"]}`
  | `lead-turn-attempt.${LeadTurnAttempt["status"]}`
  | `worker-session.${WorkerSession["state"]}`
  | `worker-execution-attempt.${WorkerExecutionAttempt["status"]}`
  | `worker-question.${WorkerQuestion["status"]}`
  | `capability-notice.${CapabilityNotice["state"]}`
  | `standing-order.${StandingOrder["state"]}`
  | `acting-authority.${ActingAuthority["state"]}`
  | `self-repair.${SelfRepairRecord["attempts"][number]["status"]}`
  | "coordination-message.recorded"
  | `forge-operation-attempt.${ForgeOperationAttempt["status"]}`
  | `forge-owner-action-notice.${ForgeOwnerActionNotice["state"]}`
  | `target-project-operation-attempt.${TargetProjectOperationAttempt["status"]}`
  | `effect-intent.${EffectIntent["status"]}`;

export function openAuthoritativeState(
  stateDirectory: string,
  options: { writeGeneration?: number } = {},
): AuthoritativeState {
  mkdirSync(stateDirectory, { recursive: true });
  if (loadRecoveryStatus(stateDirectory)) {
    throw new Error("Authoritative state recovery is active; product mutations are disabled.");
  }
  const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"));
  const writeGeneration = (() => {
    try {
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      assertDatabaseIntegrity(database);
      ensureWriteGenerationSchema(database);
      const expected = options.writeGeneration ?? readWriteGeneration(database);
      ensureSchema(database, expected);
      recordWriteGenerationHighWater(stateDirectory, readWriteGeneration(database));
      return expected;
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the original database failure; the next safe open captures the files as evidence.
      }
      throw error;
    }
  })();

  const beginWrite = (): void => {
    database.exec("BEGIN IMMEDIATE");
    try {
      assertWriteGeneration(database, writeGeneration);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

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
    beginWrite();
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
    beginWrite();
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
    beginWrite();
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

  const readCurrentSnapshot = <T>(
    kind:
      | "worker-session.snapshot"
      | "worker-execution-attempt.snapshot"
      | "worker-question.snapshot"
      | "standing-order.snapshot"
      | "acting-authority.snapshot"
      | "self-repair.snapshot"
      | "forge-operation-attempt.snapshot"
      | "forge-owner-action-notice.snapshot"
      | "commitment.snapshot"
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

  const readCurrentSnapshots = <T>(
    kind:
      | "worker-session.snapshot"
      | "worker-execution-attempt.snapshot"
      | "worker-question.snapshot"
      | "standing-order.snapshot"
      | "acting-authority.snapshot"
      | "self-repair.snapshot"
      | "forge-operation-attempt.snapshot"
      | "forge-owner-action-notice.snapshot",
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

  type DurableSnapshotEntry = {
    kind:
      | "worker-session.snapshot"
      | "worker-execution-attempt.snapshot"
      | "worker-question.snapshot"
      | "standing-order.snapshot"
      | "acting-authority.snapshot"
      | "self-repair.snapshot"
      | "forge-operation-attempt.snapshot"
      | "forge-owner-action-notice.snapshot"
      | "commitment.snapshot"
      | "effect-intent.snapshot";
    subjectPrefix:
      | "worker-session"
      | "worker-execution-attempt"
      | "worker-question"
      | "standing-order"
      | "acting-authority"
      | "self-repair"
      | "forge-operation-attempt"
      | "forge-owner-action-notice"
      | "commitment"
      | "effect-intent";
    transitionPrefix:
      | "worker-session"
      | "worker-execution-attempt"
      | "worker-question"
      | "standing-order"
      | "acting-authority"
      | "self-repair"
      | "forge-operation-attempt"
      | "forge-owner-action-notice"
      | "commitment"
      | "effect-intent";
    snapshot: { id: string; state?: string; status?: string };
  };

  const appendSnapshotBatch = (entries: DurableSnapshotEntry[]): void => {
    if (entries.length === 0) return;
    const predecessorBySubject = new Map<string, string | undefined>();
    beginWrite();
    try {
      for (const entry of entries) {
        const subjectId = `${entry.subjectPrefix}:${entry.snapshot.id}`;
        if (!predecessorBySubject.has(subjectId)) {
          predecessorBySubject.set(
            subjectId,
            readCurrentSnapshot(entry.kind, subjectId)?.id,
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

  const appendSnapshots = <T extends { id: string; state?: string; status?: string }>(
    kind:
      | "worker-session.snapshot"
      | "worker-execution-attempt.snapshot"
      | "worker-question.snapshot"
      | "standing-order.snapshot"
      | "acting-authority.snapshot"
      | "self-repair.snapshot"
      | "forge-operation-attempt.snapshot"
      | "forge-owner-action-notice.snapshot",
    subjectPrefix:
      | "worker-session"
      | "worker-execution-attempt"
      | "worker-question"
      | "standing-order"
      | "acting-authority"
      | "self-repair"
      | "forge-operation-attempt"
      | "forge-owner-action-notice",
    transitionPrefix:
      | "worker-session"
      | "worker-execution-attempt"
      | "worker-question"
      | "standing-order"
      | "acting-authority"
      | "self-repair"
      | "forge-operation-attempt"
      | "forge-owner-action-notice",
    snapshots: T[],
  ): void => {
    if (snapshots.length === 0) return;
    const subjectIdentity = snapshots[0]!.id;
    if (snapshots.some((snapshot) => snapshot.id !== subjectIdentity)) {
      throw new Error("One durable snapshot batch cannot contain multiple identities.");
    }
    appendSnapshotBatch(
      snapshots.map((snapshot) => ({
        kind,
        subjectPrefix,
        transitionPrefix,
        snapshot,
      })),
    );
  };

  const assertActingAuthorityDispatch = (
    effectIntent: EffectIntent,
    actualEffect: {
      effectClass: StandingOrder["effectClasses"][number];
      target: string;
      reversible: boolean;
      externallyBinding: boolean;
      incrementalSpendUsd: number;
    },
  ): void => {
    const actingAuthority = readCurrentSnapshots<ActingAuthority>("acting-authority.snapshot").at(-1);
    const authorization = effectIntent.authorization.actingAuthority;
    if (!actingAuthority || actingAuthority.state === "ended") {
      if (authorization) {
        throw new Error("An Acting Authority effect authorization cannot outlive command authority.");
      }
      return;
    }
    if (!actingAuthority.commitmentIds.includes(effectIntent.commitmentId)) {
      if (authorization) {
        throw new Error("Acting Authority cannot authorize an unrelated Commitment effect.");
      }
      return;
    }
    if (!authorization) {
      // Command Authority covers the dispatch whether the Owner is present or
      // absent; a Standing Order grant only attributes it, it never gates it.
      return;
    }
    if (actingAuthority.state !== "active") {
      throw new Error("An Acting Authority effect authorization cannot outlive command authority.");
    }
    const grant = (actingAuthority.effectAuthorizations ?? []).find(
      (candidate) => candidate.id === authorization.authorizationId,
    );
    const standingOrder = authorization.standingOrderId
      ? readCurrentSnapshot<StandingOrder>(
          "standing-order.snapshot",
          `standing-order:${authorization.standingOrderId}`,
        )?.value
      : undefined;
    if (
      !grant ||
      grant.actingAuthorityId !== actingAuthority.id ||
      authorization.actingAuthorityId !== actingAuthority.id ||
      grant.standingOrderId !== authorization.standingOrderId ||
      grant.commitmentId !== effectIntent.commitmentId ||
      grant.effectClass !== actualEffect.effectClass ||
      grant.target !== actualEffect.target ||
      grant.reversible !== actualEffect.reversible ||
      grant.externallyBinding !== actualEffect.externallyBinding ||
      grant.incrementalSpendUsd !== actualEffect.incrementalSpendUsd ||
      !standingOrder ||
      standingOrder.state !== "active" ||
      Date.parse(standingOrder.validUntil) <= Date.now() ||
      !standingOrder.commitmentIds.includes(grant.commitmentId) ||
      !standingOrder.effectClasses.includes(grant.effectClass) ||
      !standingOrder.targets.includes(grant.target) ||
      grant.incrementalSpendUsd > standingOrder.maximumIncrementalSpendUsd ||
      (!grant.reversible && !standingOrder.allowIrreversibleEffects) ||
      (grant.externallyBinding && !standingOrder.allowExternallyBindingEffects)
    ) {
      throw new Error("Effect dispatch does not match its durable Acting Authority authorization.");
    }
    const reused = database
      .prepare(`
        SELECT 1
          FROM facts
         WHERE kind = 'effect-intent.snapshot'
           AND json_extract(value_json, '$.authorization.actingAuthority.authorizationId') = ?
         LIMIT 1
      `)
      .get(authorization.authorizationId);
    if (reused) {
      throw new Error("An Acting Authority effect authorization can dispatch only one effect intent.");
    }
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

  const assertNoConflictingOpenEffect = (
    effectIntent: EffectIntent,
    message: string,
  ): void => {
    const conflict = database
      .prepare(`
        SELECT 1
          FROM facts current
         WHERE current.kind = 'effect-intent.snapshot'
           AND (
             COALESCE(
               json_extract(current.value_json, '$.effectScopeKey'),
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
      .get(effectScopeKey(effectIntent), effectIntent.commitmentId);
    if (conflict) throw new Error(message);
  };

  const writeAttemptAndEffectSnapshots = (input: {
    attempt: TargetProjectOperationAttempt | ForgeOperationAttempt;
    attemptFactKind: "target-project-operation-attempt.snapshot" | "forge-operation-attempt.snapshot";
    attemptSubjectPrefix: "target-project-operation-attempt" | "forge-operation-attempt";
    attemptTransitionPrefix: "target-project-operation-attempt" | "forge-operation-attempt";
    effectIntent: TargetProjectOperationEffectIntent | ForgeOperationEffectIntent;
    predecessors?: { attemptId: string; effectIntentId: string };
    beforeWrite?: () => void;
  }): void => {
    const recordedAt = new Date().toISOString();
    const attemptFactId = randomUUID();
    const effectFactId = randomUUID();
    beginWrite();
    try {
      input.beforeWrite?.();
      database
        .prepare(`
          INSERT INTO facts (
            id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          attemptFactId,
          `${input.attemptSubjectPrefix}:${input.attempt.id}`,
          input.attemptFactKind,
          JSON.stringify(input.attempt),
          input.predecessors?.attemptId ?? null,
          recordedAt,
        );
      database
        .prepare(`
          INSERT INTO transitions (id, kind, fact_id, recorded_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          `${input.attemptTransitionPrefix}.${input.attempt.status}`,
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
          `effect-intent:${input.effectIntent.id}`,
          JSON.stringify(input.effectIntent),
          input.predecessors?.effectIntentId ?? null,
          recordedAt,
        );
      database
        .prepare(`
          INSERT INTO transitions (id, kind, fact_id, recorded_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(
          randomUUID(),
          `effect-intent.${input.effectIntent.status}`,
          effectFactId,
          recordedAt,
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
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
    writeAttemptAndEffectSnapshots({
      attempt,
      attemptFactKind: "target-project-operation-attempt.snapshot",
      attemptSubjectPrefix: "target-project-operation-attempt",
      attemptTransitionPrefix: "target-project-operation-attempt",
      effectIntent,
      ...(predecessors ? { predecessors } : {}),
      ...(rejectConflictingCommitmentEffect ? { beforeWrite: () => {
        assertActingAuthorityDispatch(effectIntent, {
          effectClass: "test",
          target: attempt.operation,
          reversible: true,
          externallyBinding: false,
          incrementalSpendUsd: 0,
        });
        assertNoConflictingOpenEffect(
          effectIntent,
          "A conflicting Target Project effect is already open for this Commitment.",
        );
      } } : {}),
    });
  };

  const writeForgeOperationAndEffect = (
    attempt: ForgeOperationAttempt,
    effectIntent: ForgeOperationEffectIntent,
    predecessors?: { attemptId: string; effectIntentId: string },
    rejectConflict = false,
  ): void => {
    if (
      attempt.effectIntentId !== effectIntent.id ||
      effectIntent.forgeOperationAttemptId !== attempt.id ||
      attempt.commitmentId !== effectIntent.commitmentId ||
      attempt.provider !== effectIntent.provider
    ) {
      throw new Error("Forge Operation Attempt and effect intent attribution must match.");
    }
    writeAttemptAndEffectSnapshots({
      attempt,
      attemptFactKind: "forge-operation-attempt.snapshot",
      attemptSubjectPrefix: "forge-operation-attempt",
      attemptTransitionPrefix: "forge-operation-attempt",
      effectIntent,
      ...(predecessors ? { predecessors } : {}),
      ...(rejectConflict ? { beforeWrite: () => {
        if (attempt.target.kind !== "github-issue") {
          throw new Error("Only a typed GitHub target can dispatch a Forge mutation.");
        }
        if (!effectIntent.authorization.actingAuthority) {
          throw new Error("Public GitHub effects require a bounded Standing Order authorization.");
        }
        assertActingAuthorityDispatch(effectIntent, {
          effectClass: "update",
          target: `${attempt.target.repository}#${attempt.target.issueNumber}`,
          reversible: true,
          externallyBinding: true,
          incrementalSpendUsd: 0,
        });
        assertNoConflictingOpenEffect(
          effectIntent,
          "A conflicting effect is already open for this Forge target or Commitment.",
        );
      } } : {}),
    });
  };

  return {
    storageStatus() {
      const row = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      if (row.journal_mode !== "wal") {
        throw new Error(`Authoritative state requires SQLite WAL; found ${row.journal_mode}.`);
      }
      return { journalMode: "wal" };
    },

    lifecycleStatus() {
      const { journalMode } = this.storageStatus();
      const integrity = database.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      if (integrity.integrity_check !== "ok") {
        throw new Error(`Authoritative State integrity check failed: ${integrity.integrity_check}.`);
      }
      const schemaRevision = readSchemaRevision(database);
      if (schemaRevision !== authoritativeStateSchemaRevision) {
        throw new Error(
          `Authoritative State schema revision ${schemaRevision} is unsupported; expected ${authoritativeStateSchemaRevision}.`,
        );
      }
      return {
        schemaRevision,
        writeGeneration: readWriteGeneration(database),
        journalMode,
        integrity: "passed",
      };
    },

    probeLifecycle(nonce) {
      if (!nonce.trim()) throw new Error("Lifecycle probe nonce is required.");
      beginWrite();
      try {
        database
          .prepare("UPDATE lifecycle_metadata SET probe_nonce = ? WHERE singleton = 1")
          .run(nonce);
        const row = database
          .prepare("SELECT probe_nonce FROM lifecycle_metadata WHERE singleton = 1")
          .get() as { probe_nonce: string | null };
        if (row.probe_nonce !== nonce) throw new Error("Lifecycle write/read probe did not round-trip.");
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    initialize(configuration) {
      validateConfiguration(configuration);
      const existing = readConfigurationRow();
      if (existing) {
        if (sameConfigurationExceptForgeAuthorities(existing.value, configuration)) {
          if (JSON.stringify(existing.value.forgeAuthorities) !== JSON.stringify(configuration.forgeAuthorities)) {
            appendFact(
              { kind: "owner.configuration", value: configuration },
              "owner.forge-authorities-reconfigured",
              existing.id,
            );
          }
          return;
        }
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

    recordOwnerInteractionDisposition(ownerTurnId, kind) {
      if (this.ownerMessage(ownerTurnId) === undefined) {
        throw new Error(`Unknown Owner turn ${ownerTurnId}.`);
      }
      beginWrite();
      try {
        database
          .prepare(`
            INSERT INTO owner_interaction_dispositions (owner_turn_id, kind, recorded_at)
            VALUES (?, ?, ?)
            ON CONFLICT(owner_turn_id) DO NOTHING
          `)
          .run(ownerTurnId, kind, new Date().toISOString());
        const recorded = database
          .prepare("SELECT kind FROM owner_interaction_dispositions WHERE owner_turn_id = ?")
          .get(ownerTurnId) as { kind: "session-view-control" } | undefined;
        if (recorded?.kind !== kind) {
          throw new Error(`Owner turn ${ownerTurnId} has a different durable disposition.`);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    ownerInteractionDisposition(ownerTurnId) {
      return (database
        .prepare("SELECT kind FROM owner_interaction_dispositions WHERE owner_turn_id = ?")
        .get(ownerTurnId) as { kind: "session-view-control" } | undefined)?.kind;
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

    appendLeadAgentMessageWithAccounts(turnId, content, accounts, attribution) {
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
      const originalAttribution = JSON.parse(ownerTurn.value_json) as {
        modelSelection: ModelSelection;
        modelPolicyRevision: string;
      };
      beginWrite();
      try {
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
        const recordedAt = new Date().toISOString();
        const responseFactId = randomUUID();
        database
          .prepare(`
            INSERT INTO facts (
              id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
            ) VALUES (?, 'owner-conversation:primary', 'owner-conversation.lead-agent-message', ?, NULL, ?)
          `)
          .run(
            responseFactId,
            JSON.stringify({
              content,
              turnId,
              modelSelection: attribution?.modelSelection ?? originalAttribution.modelSelection,
              modelPolicyRevision:
                attribution?.modelPolicyRevision ?? originalAttribution.modelPolicyRevision,
              ...(attribution?.selectionReason
                ? { selectionReason: attribution.selectionReason }
                : {}),
            }),
            recordedAt,
          );
        database
          .prepare(`
            INSERT INTO transitions (id, kind, fact_id, recorded_at)
            VALUES (?, 'owner-conversation.lead-agent-message-recorded', ?, ?)
          `)
          .run(randomUUID(), responseFactId, recordedAt);
        for (const repair of accounts.selfRepairs) {
          const current = readCurrentSnapshot<SelfRepairRecord>(
            "self-repair.snapshot",
            `self-repair:${repair.id}`,
          );
          const status = repair.attempts.at(-1)?.status;
          if (!current || !status) {
            throw new Error("Self-repair account delivery requires current durable repair state.");
          }
          const repairFactId = randomUUID();
          database
            .prepare(`
              INSERT INTO facts (
                id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
              ) VALUES (?, ?, 'self-repair.snapshot', ?, ?, ?)
            `)
            .run(
              repairFactId,
              `self-repair:${repair.id}`,
              JSON.stringify(repair),
              current.id,
              recordedAt,
            );
          database
            .prepare(`
              INSERT INTO transitions (id, kind, fact_id, recorded_at)
              VALUES (?, ?, ?, ?)
            `)
            .run(randomUUID(), `self-repair.${status}`, repairFactId, recordedAt);
        }
        for (const commitment of accounts.commitments) {
          const current = readCommitmentRow(commitment.id);
          const deliveredAt = commitment.outcomeAccount?.deliveredAt;
          if (
            !current?.value.outcomeAccount ||
            current.value.outcomeAccount.deliveredAt ||
            !deliveredAt ||
            !Number.isFinite(Date.parse(deliveredAt)) ||
            JSON.stringify(commitment) !== JSON.stringify({
              ...current.value,
              outcomeAccount: { ...current.value.outcomeAccount, deliveredAt },
            })
          ) {
            throw new Error("Commitment outcome delivery requires the current pending account.");
          }
          const commitmentFactId = randomUUID();
          database
            .prepare(`
              INSERT INTO facts (
                id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
              ) VALUES (?, ?, 'commitment.snapshot', ?, ?, ?)
            `)
            .run(
              commitmentFactId,
              `commitment:${commitment.id}`,
              JSON.stringify(commitment),
              current.id,
              recordedAt,
            );
          database
            .prepare(`
              INSERT INTO transitions (id, kind, fact_id, recorded_at)
              VALUES (?, 'commitment.accepted', ?, ?)
            `)
            .run(randomUUID(), commitmentFactId, recordedAt);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
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

    ownerMessage(ownerTurnId) {
      const row = database
        .prepare(`
          SELECT value_json
            FROM facts
           WHERE kind = 'owner-conversation.owner-message'
             AND json_extract(value_json, '$.turnId') = ?
           LIMIT 1
        `)
        .get(ownerTurnId) as { value_json: string } | undefined;
      return row ? (JSON.parse(row.value_json) as { content: string }).content : undefined;
    },

    latestOwnerTurnId() {
      const row = database
        .prepare(`
          SELECT value_json
            FROM facts
           WHERE kind = 'owner-conversation.owner-message'
           ORDER BY sequence DESC
           LIMIT 1
        `)
        .get() as { value_json: string } | undefined;
      return row ? (JSON.parse(row.value_json) as { turnId: string }).turnId : undefined;
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
      let predecessorId = readCurrentSnapshot<WorkerSession>(
        "worker-session.snapshot",
        `worker-session:${workerSession.id}`,
      )?.id;
      beginWrite();
      try {
        if (effectIntent) {
          const assignment = workerSession.assignment;
          if (assignment.readOnly) {
            throw new Error("An effect intent cannot dispatch a read-only Worker assignment.");
          }
          assertActingAuthorityDispatch(effectIntent, {
            effectClass:
              assignment.coordination?.role === "implementer" &&
              assignment.coordination.repairOfReviewFindingIds?.length
                ? "self-repair"
                : "update",
            target: assignment.targetProjectPath,
            reversible: true,
            externallyBinding: false,
            incrementalSpendUsd: assignment.costBound.maximumIncrementalSpendUsd,
          });
          const conflict = database
            .prepare(`
              SELECT 1
                FROM facts current
               WHERE current.kind = 'effect-intent.snapshot'
                  AND COALESCE(
                    json_extract(current.value_json, '$.effectScopeKey'),
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
            .get(effectScopeKey(effectIntent));
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
      appendSnapshotBatch([
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

    transitionExecutionCheckout(input) {
      appendSnapshotBatch([
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
        {
          kind: "worker-session.snapshot" as const,
          subjectPrefix: "worker-session" as const,
          transitionPrefix: "worker-session" as const,
          snapshot: input.workerSession,
        },
        ...(input.commitmentSnapshots ?? []).map((commitment) => ({
          kind: "commitment.snapshot" as const,
          subjectPrefix: "commitment" as const,
          transitionPrefix: "commitment" as const,
          snapshot: commitment,
        })),
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
      beginWrite();
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

    appendStandingOrderSnapshots(snapshots) {
      appendSnapshots(
        "standing-order.snapshot",
        "standing-order",
        "standing-order",
        snapshots,
      );
    },

    readStandingOrder(standingOrderId) {
      return readCurrentSnapshot<StandingOrder>(
        "standing-order.snapshot",
        `standing-order:${standingOrderId}`,
      )?.value;
    },

    readStandingOrders() {
      return readCurrentSnapshots<StandingOrder>("standing-order.snapshot");
    },

    appendActingAuthoritySnapshots(snapshots) {
      appendSnapshots(
        "acting-authority.snapshot",
        "acting-authority",
        "acting-authority",
        snapshots,
      );
    },

    readActingAuthority(actingAuthorityId) {
      return readCurrentSnapshot<ActingAuthority>(
        "acting-authority.snapshot",
        `acting-authority:${actingAuthorityId}`,
      )?.value;
    },

    readActingAuthorities() {
      return readCurrentSnapshots<ActingAuthority>("acting-authority.snapshot");
    },

    appendSelfRepairSnapshots(snapshots) {
      if (snapshots.length === 0) return;
      const selfRepairId = snapshots[0]!.id;
      if (snapshots.some((snapshot) => snapshot.id !== selfRepairId)) {
        throw new Error("One Self-repair snapshot batch cannot contain multiple identities.");
      }
      let predecessorId = readCurrentSnapshot<SelfRepairRecord>(
        "self-repair.snapshot",
        `self-repair:${selfRepairId}`,
      )?.id;
      for (const snapshot of snapshots) {
        const status = snapshot.attempts.at(-1)?.status;
        if (!status) throw new Error("A Self-repair snapshot requires one repair attempt.");
        predecessorId = appendFact(
          { kind: "self-repair.snapshot", value: snapshot },
          `self-repair.${status}`,
          predecessorId,
        );
      }
    },

    readSelfRepair(selfRepairId) {
      return readCurrentSnapshot<SelfRepairRecord>(
        "self-repair.snapshot",
        `self-repair:${selfRepairId}`,
      )?.value;
    },

    readSelfRepairs() {
      return readCurrentSnapshots<SelfRepairRecord>("self-repair.snapshot");
    },

    appendCoordinationMessage(message) {
      appendFact(
        { kind: "coordination-message.recorded", value: message },
        "coordination-message.recorded",
      );
    },

    readCoordinationMessages() {
      const rows = database
        .prepare(`
          SELECT value_json
            FROM facts
           WHERE kind = 'coordination-message.recorded'
           ORDER BY sequence
        `)
        .all() as Array<{ value_json: string }>;
      return rows.map((row) => JSON.parse(row.value_json) as CoordinationMessage);
    },

    appendWorkerSessionSnapshots(snapshots) {
      appendSnapshots(
        "worker-session.snapshot",
        "worker-session",
        "worker-session",
        snapshots,
      );
    },

    readWorkerSession(workerSessionId) {
      return readCurrentSnapshot<WorkerSession>(
        "worker-session.snapshot",
        `worker-session:${workerSessionId}`,
      )?.value;
    },

    readWorkerSessions() {
      return readCurrentSnapshots<WorkerSession>("worker-session.snapshot");
    },

    appendWorkerExecutionAttemptSnapshots(snapshots) {
      appendSnapshots(
        "worker-execution-attempt.snapshot",
        "worker-execution-attempt",
        "worker-execution-attempt",
        snapshots,
      );
    },

    readWorkerExecutionAttempt(attemptId) {
      return readCurrentSnapshot<WorkerExecutionAttempt>(
        "worker-execution-attempt.snapshot",
        `worker-execution-attempt:${attemptId}`,
      )?.value;
    },

    readWorkerExecutionAttempts() {
      return readCurrentSnapshots<WorkerExecutionAttempt>(
        "worker-execution-attempt.snapshot",
      );
    },

    appendWorkerQuestionSnapshots(snapshots) {
      appendSnapshots(
        "worker-question.snapshot",
        "worker-question",
        "worker-question",
        snapshots,
      );
    },

    readWorkerQuestion(questionId) {
      return readCurrentSnapshot<WorkerQuestion>(
        "worker-question.snapshot",
        `worker-question:${questionId}`,
      )?.value;
    },

    readWorkerQuestions() {
      return readCurrentSnapshots<WorkerQuestion>("worker-question.snapshot");
    },

    appendForgeOperationAttemptSnapshots(snapshots) {
      if (snapshots.some((snapshot) => snapshot.effectIntentId)) {
        throw new Error("Mutating Forge attempts must be recorded atomically with their effect intent.");
      }
      appendSnapshots(
        "forge-operation-attempt.snapshot",
        "forge-operation-attempt",
        "forge-operation-attempt",
        snapshots,
      );
    },

    readForgeOperationAttempt(attemptId) {
      return readCurrentSnapshot<ForgeOperationAttempt>(
        "forge-operation-attempt.snapshot",
        `forge-operation-attempt:${attemptId}`,
      )?.value;
    },

    readForgeOperationAttempts() {
      return readCurrentSnapshots<ForgeOperationAttempt>("forge-operation-attempt.snapshot");
    },

    startForgeMutation(attempt, effectIntent) {
      if (
        readCurrentSnapshot(
          "forge-operation-attempt.snapshot",
          `forge-operation-attempt:${attempt.id}`,
        ) ||
        readEffectIntentRow(effectIntent.id)
      ) {
        throw new Error("Forge Operation Attempt and effect intent identities must be new.");
      }
      if (attempt.status !== "ready" || effectIntent.status !== "pending") {
        throw new Error("A Forge mutation must record ready intent before dispatch.");
      }
      writeForgeOperationAndEffect(attempt, effectIntent, undefined, true);
    },

    claimForgeMutation(attempt, effectIntent) {
      const currentAttempt = readCurrentSnapshot<ForgeOperationAttempt>(
        "forge-operation-attempt.snapshot",
        `forge-operation-attempt:${attempt.id}`,
      );
      const currentEffect = readEffectIntentRow(effectIntent.id);
      if (!currentAttempt || !currentEffect) {
        throw new Error("Cannot claim an unknown Forge mutation.");
      }
      if (currentAttempt.value.status !== "ready" || currentEffect.value.status !== "pending") {
        throw new Error("Forge mutation is not ready for dispatch.");
      }
      if (attempt.status !== "running" || effectIntent.status !== "dispatching" || !effectIntent.lease) {
        throw new Error("Forge dispatch claim requires a running attempt and durable effect lease.");
      }
      writeForgeOperationAndEffect(attempt, effectIntent, {
        attemptId: currentAttempt.id,
        effectIntentId: currentEffect.id,
      });
    },

    settleForgeMutation(attempt, effectIntent) {
      const currentAttempt = readCurrentSnapshot<ForgeOperationAttempt>(
        "forge-operation-attempt.snapshot",
        `forge-operation-attempt:${attempt.id}`,
      );
      const currentEffect = readEffectIntentRow(effectIntent.id);
      if (!currentAttempt || !currentEffect) {
        throw new Error("Cannot settle an unknown Forge mutation.");
      }
      const dispatched =
        currentAttempt.value.status === "running" &&
        currentEffect.value.status === "dispatching" &&
        ["succeeded", "unknown"].includes(attempt.status) &&
        ["succeeded", "unknown"].includes(effectIntent.status);
      const undispatched =
        currentAttempt.value.status === "ready" &&
        currentEffect.value.status === "pending" &&
        attempt.status === "rejected" &&
        effectIntent.status === "rejected";
      if (!dispatched && !undispatched) {
        throw new Error("Forge mutation is not dispatching or has an invalid settlement.");
      }
      writeForgeOperationAndEffect(attempt, effectIntent, {
        attemptId: currentAttempt.id,
        effectIntentId: currentEffect.id,
      });
    },

    readForgeOwnerActionNotice(id) {
      return readCurrentSnapshot<ForgeOwnerActionNotice>(
        "forge-owner-action-notice.snapshot",
        `forge-owner-action-notice:${id}`,
      )?.value;
    },

    readForgeOwnerActionNotices() {
      return readCurrentSnapshots<ForgeOwnerActionNotice>("forge-owner-action-notice.snapshot");
    },

    appendForgeOwnerActionNotice(notice) {
      appendSnapshots(
        "forge-owner-action-notice.snapshot",
        "forge-owner-action-notice",
        "forge-owner-action-notice",
        [notice],
      );
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
      beginWrite();
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
      const destination = resolve(databasePath);
      const liveDatabase = resolve(join(stateDirectory, "authoritative-state.sqlite"));
      if (destination === liveDatabase) {
        throw new Error("An Authoritative State backup cannot replace the live database.");
      }
      if (existsSync(destination) || existsSync(backupManifestPath(destination))) {
        throw new Error("An Authoritative State backup requires a new destination.");
      }
      mkdirSync(dirname(destination), { recursive: true });
      const backupIdentity = (() => {
        beginWrite();
        try {
          if (!readConfigurationRow()) {
            throw new Error("An Authoritative State backup requires initialized CMD Riker state.");
          }
          assertDatabaseIntegrity(database);
          const row = database
            .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM facts")
            .get() as { sequence: number };
          const identity = readStateIdentity(database);
          const backupId = randomUUID();
          const createdAt = new Date().toISOString();
          database
            .prepare(`
              INSERT INTO state_backups (
                id, state_id, write_generation, last_journal_sequence, created_at
              ) VALUES (?, ?, ?, ?, ?)
            `)
            .run(backupId, identity.stateId, identity.writeGeneration, row.sequence, createdAt);
          database.exec("COMMIT");
          return { backupId, createdAt, identity, lastJournalSequence: row.sequence };
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      })();
      try {
        await backupDatabase(database, destination);
        const manifest: AuthoritativeStateBackup = {
          version: 1,
          backupId: backupIdentity.backupId,
          sourceStateId: backupIdentity.identity.stateId,
          writeGeneration: backupIdentity.identity.writeGeneration,
          databasePath: destination,
          sha256: sha256File(destination),
          createdAt: backupIdentity.createdAt,
          lastJournalSequence: backupIdentity.lastJournalSequence,
        };
        verifyCmdRikerBackupProvenance(destination, manifest);
        writeJsonAtomically(backupManifestPath(destination), manifest);
        return manifest;
      } catch (error) {
        rmSync(destination, { force: true });
        rmSync(backupManifestPath(destination), { force: true });
        throw error;
      }
    },

    close() {
      database.close();
    },
  };
}

export function openAuthoritativeStateSafely(
  stateDirectory: string,
  options: { writeGeneration?: number } = {},
): AuthoritativeStateOpenResult {
  mkdirSync(stateDirectory, { recursive: true });
  const activeRecovery = loadRecoveryStatus(stateDirectory);
  if (activeRecovery) return { kind: "recovery-required", recovery: activeRecovery };
  try {
    return { kind: "operational", state: openAuthoritativeState(stateDirectory, options) };
  } catch (error) {
    if (error instanceof StaleWriteGenerationError) throw error;
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
  const restoredWriteGeneration = Math.max(
    backup.writeGeneration,
    recovery.failedWriteGeneration ?? 0,
    readWriteGenerationHighWater(stateDirectory) ?? 0,
  ) + 1;
  recordWriteGenerationHighWater(stateDirectory, restoredWriteGeneration);
  let restoredDatabaseSha256: string;
  try {
    verifyDatabaseFile(restoreCandidate);
    setDatabaseWriteGeneration(restoreCandidate, restoredWriteGeneration);
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
    restoredDatabaseSha256 = sha256File(databasePath);
    verifyCmdRikerBackupProvenance(databasePath, backup, {
      writeGeneration: restoredWriteGeneration,
      sha256: restoredDatabaseSha256,
    });
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
    restoredWriteGeneration,
    restoredDatabaseSha256,
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
    !recovery.restoredBackup ||
    recovery.restoredWriteGeneration === undefined ||
    recovery.restoredDatabaseSha256 === undefined
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
    !recovery.restoredBackup ||
    recovery.restoredWriteGeneration === undefined ||
    recovery.restoredDatabaseSha256 === undefined
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
    {
      writeGeneration: recovery.restoredWriteGeneration,
      sha256: recovery.restoredDatabaseSha256,
    },
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
    const candidateGeneration = Math.max(
      recovery.failedWriteGeneration ?? 0,
      readWriteGenerationHighWater(stateDirectory) ?? 0,
      1,
    ) + 1;
    setDatabaseWriteGeneration(candidateDatabase, candidateGeneration);
    recordWriteGenerationHighWater(stateDirectory, candidateGeneration);
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

function setDatabaseWriteGeneration(databasePath: string, writeGeneration: number): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE;");
    const result = database
      .prepare(`
        UPDATE lifecycle_metadata
           SET write_generation = ?, probe_nonce = NULL
         WHERE singleton = 1
      `)
      .run(writeGeneration);
    if (result.changes !== 1) {
      throw new Error("Restored Authoritative State is missing its write-generation identity.");
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
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
      SELECT identity.state_id AS stateId,
             lifecycle.write_generation AS writeGeneration
        FROM state_identity identity
        JOIN lifecycle_metadata lifecycle
          ON lifecycle.singleton = identity.singleton
       WHERE identity.singleton = 1
    `)
    .get() as { stateId: string; writeGeneration: number } | undefined;
  if (!row) throw new Error("CMD Riker Authoritative State identity is missing.");
  return row;
}

function verifyCmdRikerBackupProvenance(
  databasePath: string,
  manifest: AuthoritativeStateBackup,
  restored?: { writeGeneration: number; sha256: string },
): void {
  if (sha256File(databasePath) !== (restored?.sha256 ?? manifest.sha256)) {
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
      identity.writeGeneration !== (restored?.writeGeneration ?? manifest.writeGeneration) ||
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
    ...bestEffortWriteGeneration(stateDirectory),
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
    ...bestEffortWriteGeneration(stateDirectory),
  };
  writeRecoveryStatus(stateDirectory, recovery);
  return recovery;
}

function bestEffortWriteGeneration(
  stateDirectory: string,
): Pick<AuthoritativeStateRecovery, "failedWriteGeneration"> {
  const highWater = readWriteGenerationHighWater(stateDirectory);
  try {
    const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"), {
      readOnly: true,
    });
    try {
      return {
        failedWriteGeneration: Math.max(readWriteGeneration(database), highWater ?? 0),
      };
    } finally {
      database.close();
    }
  } catch {
    return highWater === undefined ? {} : { failedWriteGeneration: highWater };
  }
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

function ensureSchema(database: DatabaseSync, writeGeneration: number): void {
  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    assertWriteGeneration(database, writeGeneration);
    const schemaRevision = readSchemaRevision(database);
    if (schemaRevision !== authoritativeStateSchemaRevision) {
      throw new Error(
        `Authoritative State schema revision ${schemaRevision} is unsupported; expected ${authoritativeStateSchemaRevision}.`,
      );
    }
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
        'standing-order.snapshot',
        'acting-authority.snapshot',
        'self-repair.snapshot',
        'coordination-message.recorded',
        'forge-operation-attempt.snapshot',
        'forge-owner-action-notice.snapshot',
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
        'owner.forge-authorities-reconfigured',
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
        'standing-order.active',
        'standing-order.revoked',
        'acting-authority.active',
        'acting-authority.handoff-pending',
        'acting-authority.ended',
        'self-repair.candidate-delegation-pending',
        'self-repair.candidate-delegated',
        'self-repair.review-delegation-pending',
        'self-repair.review-delegated',
        'self-repair.activation-pending',
        'self-repair.activated',
        'self-repair.rolled-back',
        'self-repair.blocked',
        'coordination-message.recorded',
        'forge-operation-attempt.ready',
        'forge-operation-attempt.running',
        'forge-operation-attempt.succeeded',
        'forge-operation-attempt.failed',
        'forge-operation-attempt.timed-out',
        'forge-operation-attempt.unknown',
        'forge-operation-attempt.rejected',
        'forge-operation-attempt.unavailable',
        'forge-owner-action-notice.active',
        'forge-owner-action-notice.cleared',
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
      state_id TEXT NOT NULL UNIQUE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS state_backups (
      id TEXT PRIMARY KEY,
      state_id TEXT NOT NULL,
      write_generation INTEGER NOT NULL CHECK (write_generation > 0),
      last_journal_sequence INTEGER NOT NULL CHECK (last_journal_sequence >= 0),
      created_at TEXT NOT NULL,
      FOREIGN KEY (state_id) REFERENCES state_identity(state_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS owner_interaction_dispositions (
      owner_turn_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('session-view-control')),
      recorded_at TEXT NOT NULL
    ) STRICT;
  `);
  const stateIdentityColumns = database
    .prepare("PRAGMA table_info(state_identity)")
    .all() as Array<{ name: string }>;
  if (stateIdentityColumns.some((column) => column.name === "write_generation")) {
    database.exec("ALTER TABLE state_identity DROP COLUMN write_generation;");
  }
  database
    .prepare(`
      INSERT OR IGNORE INTO state_identity (singleton, state_id)
      VALUES (1, ?)
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
    row.sql.includes("'standing-order.snapshot'") &&
    row.sql.includes("'acting-authority.snapshot'") &&
    row.sql.includes("'self-repair.snapshot'") &&
    row.sql.includes("'coordination-message.recorded'") &&
    row.sql.includes("'forge-operation-attempt.snapshot'") &&
    row.sql.includes("'forge-owner-action-notice.snapshot'") &&
    row.sql.includes("'target-project-operation-attempt.snapshot'") &&
    row.sql.includes("'effect-intent.snapshot'") &&
    transitionsRow.sql.includes("'worker-execution-attempt.timed-out'") &&
    transitionsRow.sql.includes("'self-repair.activation-pending'") &&
    transitionsRow.sql.includes("'owner.forge-authorities-reconfigured'") &&
    transitionsRow.sql.includes("'forge-owner-action-notice.cleared'") &&
    transitionsRow.sql.includes("'effect-intent.reconciled'")
  ) {
    database.exec("COMMIT");
    return;
  }

    database.exec(`
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
          'standing-order.snapshot',
          'acting-authority.snapshot',
          'self-repair.snapshot',
          'coordination-message.recorded',
          'forge-operation-attempt.snapshot',
          'forge-owner-action-notice.snapshot',
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
          'owner.forge-authorities-reconfigured',
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
          'standing-order.active',
          'standing-order.revoked',
          'acting-authority.active',
          'acting-authority.handoff-pending',
          'acting-authority.ended',
          'self-repair.candidate-delegation-pending',
          'self-repair.candidate-delegated',
          'self-repair.review-delegation-pending',
          'self-repair.review-delegated',
          'self-repair.activation-pending',
          'self-repair.activated',
          'self-repair.rolled-back',
          'self-repair.blocked',
          'coordination-message.recorded',
          'forge-operation-attempt.ready',
          'forge-operation-attempt.running',
          'forge-operation-attempt.succeeded',
          'forge-operation-attempt.failed',
          'forge-operation-attempt.timed-out',
          'forge-operation-attempt.unknown',
          'forge-operation-attempt.rejected',
          'forge-operation-attempt.unavailable',
          'forge-owner-action-notice.active',
          'forge-owner-action-notice.cleared',
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
    `);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
}

function readSchemaRevision(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT schema_revision FROM lifecycle_metadata WHERE singleton = 1")
    .get() as { schema_revision: number } | undefined;
  if (!row) throw new Error("Authoritative State schema revision is unavailable.");
  return row.schema_revision;
}

function parseConfiguration(valueJson: string): OwnerConfiguration {
  const value = JSON.parse(valueJson) as OwnerConfiguration;
  return {
    targetProject: value.targetProject,
    ...(value.forgeAuthorities ? { forgeAuthorities: value.forgeAuthorities } : {}),
    modelSelection: value.modelSelection,
    ...(Array.isArray(value.modelFallbacks) ? { modelFallbacks: value.modelFallbacks } : {}),
    ...(value.modelRequirements ? { modelRequirements: value.modelRequirements } : {}),
    modelPolicyRevision: value.modelPolicyRevision,
    ...(value.workerModelPolicy ? { workerModelPolicy: value.workerModelPolicy } : {}),
    ...(value.workerHarnessSettings
      ? { workerHarnessSettings: value.workerHarnessSettings }
      : {}),
  };
}

function validateConfiguration(configuration: OwnerConfiguration): void {
  const github = configuration.forgeAuthorities?.github;
  if (
    github &&
    (!github.account.trim() || !/^[^/\s]+\/[^/\s]+$/.test(github.repository))
  ) {
    throw new Error("GitHub Forge authority requires an account and owner/repository target.");
  }
  const azure = configuration.forgeAuthorities?.azure;
  if (
    azure &&
    (!azure.account.trim() || !/^[0-9a-f-]{36}$/i.test(azure.subscriptionId))
  ) {
    throw new Error("Azure Forge authority requires an account and subscription UUID.");
  }
  assertSupportedModelSelection(configuration.modelSelection);
  for (const fallback of configuration.modelFallbacks ?? []) {
    assertSupportedModelSelection(fallback);
  }
  if (configuration.workerModelPolicy) {
    const { revision, selection } = configuration.workerModelPolicy;
    if (!revision.trim()) throw new Error("Worker Model Policy revision is required.");
    assertSupportedWorkerModelSelection(selection);
  }
  for (const [harness, setting] of Object.entries(configuration.workerHarnessSettings ?? {})) {
    if (!["codex", "claude", "copilot"].includes(harness)) {
      throw new Error(`Unknown Native Harness ${harness} in harness settings.`);
    }
    if (typeof setting?.enabled !== "boolean") {
      throw new Error(`Harness ${harness} settings require an explicit enabled flag.`);
    }
    if (setting.model !== undefined && !setting.model.trim()) {
      throw new Error(`Harness ${harness} settings cannot carry an empty model.`);
    }
  }
}

function sameEffectIntentIdentityAndScope(left: EffectIntent, right: EffectIntent): boolean {
  if (
    left.id !== right.id ||
    left.kind !== right.kind ||
    left.commitmentId !== right.commitmentId ||
    left.expectedEffect !== right.expectedEffect ||
    effectScopeKey(left) !== effectScopeKey(right) ||
    left.retryRule !== right.retryRule ||
    left.authorization.kind !== right.authorization.kind ||
    left.authorization.commitmentId !== right.authorization.commitmentId ||
    left.authorization.targetProjectPath !== right.authorization.targetProjectPath ||
    JSON.stringify(left.authorization.providerTarget) !== JSON.stringify(right.authorization.providerTarget) ||
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
  if (left.kind === "forge-operation") {
    return (
      right.kind === "forge-operation" &&
      left.forgeOperationAttemptId === right.forgeOperationAttemptId &&
      left.provider === right.provider
    );
  }
  return (
    right.kind === "worker-assignment" &&
    left.workerSessionId === right.workerSessionId &&
    left.executionAttemptId === right.executionAttemptId &&
    left.verificationOperationAttemptId === right.verificationOperationAttemptId
  );
}

function effectScopeKey(effectIntent: EffectIntent): string {
  const key = effectIntent.effectScopeKey ??
    effectIntent.authorizedWriteRootKey ??
    effectIntent.authorization.targetProjectPath?.toLowerCase();
  if (key) return key;
  const providerTarget = effectIntent.authorization.providerTarget;
  if (providerTarget) return `${providerTarget.provider}:${providerTarget.resource}`;
  throw new Error("An effect intent requires one durable scope key.");
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
    case "standing-order.snapshot":
      return `standing-order:${input.value.id}`;
    case "acting-authority.snapshot":
      return `acting-authority:${input.value.id}`;
    case "self-repair.snapshot":
      return `self-repair:${input.value.id}`;
    case "coordination-message.recorded":
      return `coordination-message:${input.value.id}`;
    case "forge-operation-attempt.snapshot":
      return `forge-operation-attempt:${input.value.id}`;
    case "forge-owner-action-notice.snapshot":
      return `forge-owner-action-notice:${input.value.id}`;
    case "target-project-operation-attempt.snapshot":
      return `target-project-operation-attempt:${input.value.id}`;
    case "effect-intent.snapshot":
      return `effect-intent:${input.value.id}`;
  }
}

function sameConfiguration(left: OwnerConfiguration, right: OwnerConfiguration): boolean {
  return (
    left.targetProject.path === right.targetProject.path &&
    JSON.stringify(left.forgeAuthorities) === JSON.stringify(right.forgeAuthorities) &&
    sameSelection(left.modelSelection, right.modelSelection) &&
    sameSelectionList(left.modelFallbacks ?? [], right.modelFallbacks ?? []) &&
    JSON.stringify(left.modelRequirements) === JSON.stringify(right.modelRequirements) &&
    left.modelPolicyRevision === right.modelPolicyRevision &&
    JSON.stringify(left.workerModelPolicy) === JSON.stringify(right.workerModelPolicy)
  );
}

function sameConfigurationExceptForgeAuthorities(
  left: OwnerConfiguration,
  right: OwnerConfiguration,
): boolean {
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
