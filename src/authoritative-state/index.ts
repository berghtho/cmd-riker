import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertSupportedModelSelection,
  type ModelSelection,
} from "../model-selection.ts";
import type {
  Commitment,
  LeadTurnAttempt,
  OwnerConfiguration,
} from "../orchestration-core/index.ts";
import type {
  EffectIntent,
  TargetProjectOperationAttempt,
} from "../target-project-operations/index.ts";

export type { ModelSelection } from "../model-selection.ts";
export type {
  Commitment,
  CommitmentCriterion,
  CommitmentDraft,
  CommitmentState,
  LeadModelPolicy,
  LeadTurnAttempt,
  ModelCandidateValidation,
  OwnerConfiguration,
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
  startTargetProjectOperation(
    attempt: TargetProjectOperationAttempt,
    effectIntent: EffectIntent,
  ): void;
  claimTargetProjectOperationDispatch(
    attempt: TargetProjectOperationAttempt,
    effectIntent: EffectIntent,
  ): void;
  settleTargetProjectOperation(
    attempt: TargetProjectOperationAttempt,
    effectIntent: EffectIntent,
  ): void;
  readTargetProjectOperationAttempt(attemptId: string): TargetProjectOperationAttempt | undefined;
  readTargetProjectOperationAttempts(): TargetProjectOperationAttempt[];
  readEffectIntent(effectIntentId: string): EffectIntent | undefined;
  readEffectIntents(): EffectIntent[];
  readCommitmentHistory(commitmentId: string): Array<{
    sequence: number;
    commitment: Commitment;
  }>;
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
  | `target-project-operation-attempt.${TargetProjectOperationAttempt["status"]}`
  | `effect-intent.${EffectIntent["status"]}`;

export function openAuthoritativeState(stateDirectory: string): AuthoritativeState {
  mkdirSync(stateDirectory, { recursive: true });
  const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  ensureSchema(database);

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
    effectIntent: EffectIntent,
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
               AND json_extract(current.value_json, '$.commitmentId') = ?
               AND json_extract(current.value_json, '$.status') IN ('pending', 'dispatching', 'unknown')
               AND NOT EXISTS (
                 SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
               )
             LIMIT 1
          `)
          .get(effectIntent.commitmentId);
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

    close() {
      database.close();
    },
  };
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
        'effect-intent.rejected'
      )),
      fact_id TEXT NOT NULL UNIQUE REFERENCES facts(id),
      recorded_at TEXT NOT NULL
    ) STRICT;
  `);
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'facts'")
    .get() as { sql: string };
  if (
    row.sql.includes("'commitment.snapshot'") &&
    row.sql.includes("'lead-turn-attempt.snapshot'") &&
    row.sql.includes("'target-project-operation-attempt.snapshot'") &&
    row.sql.includes("'effect-intent.snapshot'")
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
          'effect-intent.rejected'
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
  };
}

function validateConfiguration(configuration: OwnerConfiguration): void {
  assertSupportedModelSelection(configuration.modelSelection);
  for (const fallback of configuration.modelFallbacks ?? []) {
    assertSupportedModelSelection(fallback);
  }
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
    left.modelPolicyRevision === right.modelPolicyRevision
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
