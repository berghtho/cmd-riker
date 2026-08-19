import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertSupportedModelSelection,
  type ModelSelection,
} from "../model-selection.ts";

export type { ModelSelection } from "../model-selection.ts";

export type OwnerConfiguration = {
  targetProject: { path: string };
  modelSelection: ModelSelection;
  modelPolicyRevision: string;
};

export type ConversationMessage =
  | {
      sequence: number;
      role: "owner";
      content: string;
      turnId: string;
      modelSelection: ModelSelection;
      modelPolicyRevision: string;
    }
  | {
      sequence: number;
      role: "lead-agent";
      content: string;
      turnId: string;
      modelSelection: ModelSelection;
      modelPolicyRevision: string;
    };

export type OwnerConversation = OwnerConfiguration & {
  messages: ConversationMessage[];
};

export interface AuthoritativeState {
  storageStatus(): { journalMode: "wal" };
  initialize(configuration: OwnerConfiguration): void;
  readOwnerConversation(): OwnerConversation | undefined;
  appendOwnerMessage(content: string): string;
  appendLeadAgentMessage(turnId: string, content: string): void;
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
      };
    };

type JournalRow = {
  sequence: number;
  kind: FactDraft["kind"];
  value_json: string;
};

type TransitionKind =
  | "owner.configuration-recorded"
  | "owner-conversation.owner-message-recorded"
  | "owner-conversation.lead-agent-message-recorded";

export function openAuthoritativeState(stateDirectory: string): AuthoritativeState {
  mkdirSync(stateDirectory, { recursive: true });
  const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      subject_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'owner.configuration',
        'owner-conversation.owner-message',
        'owner-conversation.lead-agent-message'
      )),
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),
      supersedes_fact_id TEXT REFERENCES facts(id),
      recorded_at TEXT NOT NULL
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS facts_one_successor
      ON facts(supersedes_fact_id) WHERE supersedes_fact_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS transitions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      fact_id TEXT NOT NULL UNIQUE REFERENCES facts(id),
      recorded_at TEXT NOT NULL
    ) STRICT;
  `);

  const readConfiguration = (): OwnerConfiguration | undefined => {
    const row = database
      .prepare(`
        SELECT value_json
          FROM facts current
         WHERE current.kind = 'owner.configuration'
           AND NOT EXISTS (
             SELECT 1 FROM facts successor WHERE successor.supersedes_fact_id = current.id
           )
         ORDER BY current.sequence DESC
         LIMIT 1
      `)
      .get() as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as OwnerConfiguration) : undefined;
  };

  const appendFact = (input: FactDraft): void => {
    const { subjectId, transitionKind } = factMetadata(input.kind);
    const factId = randomUUID();
    const transitionId = randomUUID();
    const recordedAt = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(`
          INSERT INTO facts (
            id, subject_id, kind, value_json, supersedes_fact_id, recorded_at
          ) VALUES (?, ?, ?, ?, NULL, ?)
        `)
        .run(
          factId,
          subjectId,
          input.kind,
          JSON.stringify(input.value),
          recordedAt,
        );
      database
        .prepare(`
          INSERT INTO transitions (id, kind, fact_id, recorded_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(transitionId, transitionKind, factId, recordedAt);
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
      assertSupportedModelSelection(configuration.modelSelection);
      const existing = readConfiguration();
      if (existing) {
        if (!sameConfiguration(existing, configuration)) {
          throw new Error("Authoritative state is already configured for a different Owner context.");
        }
        return;
      }
      appendFact({
        kind: "owner.configuration",
        value: configuration,
      });
    },

    readOwnerConversation() {
      const configuration = readConfiguration();
      if (!configuration) return undefined;
      const rows = database
        .prepare(`
          SELECT ROW_NUMBER() OVER (ORDER BY sequence) AS sequence, kind, value_json
            FROM facts
           WHERE kind IN (
             'owner-conversation.owner-message',
             'owner-conversation.lead-agent-message'
           )
           ORDER BY sequence
        `)
        .all() as JournalRow[];
      const messages: ConversationMessage[] = rows.map((row) => {
        if (row.kind === "owner-conversation.owner-message") {
          const value = JSON.parse(row.value_json) as {
            content: string;
            turnId: string;
            modelSelection: ModelSelection;
            modelPolicyRevision: string;
          };
          return {
            sequence: row.sequence,
            role: "owner",
            content: value.content,
            turnId: value.turnId,
            modelSelection: value.modelSelection,
            modelPolicyRevision: value.modelPolicyRevision,
          };
        }
        const value = JSON.parse(row.value_json) as {
          content: string;
          turnId: string;
          modelSelection: ModelSelection;
          modelPolicyRevision: string;
        };
        return {
          sequence: row.sequence,
          role: "lead-agent",
          content: value.content,
          turnId: value.turnId,
          modelSelection: value.modelSelection,
          modelPolicyRevision: value.modelPolicyRevision,
        };
      });
      return { ...configuration, messages };
    },

    appendOwnerMessage(content) {
      const configuration = readConfiguration();
      if (!configuration) throw new Error("Authoritative state is not configured.");
      const turnId = randomUUID();
      appendFact({
        kind: "owner-conversation.owner-message",
        value: {
          content,
          turnId,
          modelSelection: configuration.modelSelection,
          modelPolicyRevision: configuration.modelPolicyRevision,
        },
      });
      return turnId;
    },

    appendLeadAgentMessage(turnId, content) {
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
      const attribution = JSON.parse(ownerTurn.value_json) as {
        modelSelection: ModelSelection;
        modelPolicyRevision: string;
      };
      appendFact({
        kind: "owner-conversation.lead-agent-message",
        value: {
          content,
          turnId,
          modelSelection: attribution.modelSelection,
          modelPolicyRevision: attribution.modelPolicyRevision,
        },
      });
    },

    close() {
      database.close();
    },
  };
}

function factMetadata(kind: FactDraft["kind"]): {
  subjectId: string;
  transitionKind: TransitionKind;
} {
  switch (kind) {
    case "owner.configuration":
      return { subjectId: "owner:primary", transitionKind: "owner.configuration-recorded" };
    case "owner-conversation.owner-message":
      return {
        subjectId: "owner-conversation:primary",
        transitionKind: "owner-conversation.owner-message-recorded",
      };
    case "owner-conversation.lead-agent-message":
      return {
        subjectId: "owner-conversation:primary",
        transitionKind: "owner-conversation.lead-agent-message-recorded",
      };
  }
}

function sameConfiguration(left: OwnerConfiguration, right: OwnerConfiguration): boolean {
  return (
    left.targetProject.path === right.targetProject.path &&
    left.modelSelection.provider === right.modelSelection.provider &&
    left.modelSelection.model === right.modelSelection.model &&
    left.modelSelection.api === right.modelSelection.api &&
    left.modelSelection.baseUrl === right.modelSelection.baseUrl &&
    left.modelPolicyRevision === right.modelPolicyRevision
  );
}
