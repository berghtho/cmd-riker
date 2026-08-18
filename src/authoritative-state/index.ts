import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ModelSelection = {
  provider: string;
  model: string;
  api: "openai-completions";
  baseUrl: string;
};

export type OwnerConfiguration = {
  targetProject: { path: string };
  modelSelection: ModelSelection;
  modelPolicyRevision: string;
};

export type ConversationMessage =
  | { sequence: number; role: "owner"; content: string }
  | {
      sequence: number;
      role: "lead-agent";
      content: string;
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
  appendOwnerMessage(content: string): void;
  appendLeadAgentMessage(content: string): void;
  close(): void;
}

export function openAuthoritativeState(stateDirectory: string): AuthoritativeState {
  mkdirSync(stateDirectory, { recursive: true });
  const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS owner_configuration (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      target_project_path TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_api TEXT NOT NULL CHECK (model_api = 'openai-completions'),
      model_base_url TEXT NOT NULL,
      model_policy_revision TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS owner_conversation (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('owner', 'lead-agent')),
      content TEXT NOT NULL,
      model_provider TEXT,
      model_id TEXT,
      model_api TEXT,
      model_base_url TEXT,
      model_policy_revision TEXT,
      CHECK (
        (role = 'owner' AND model_provider IS NULL AND model_id IS NULL
          AND model_api IS NULL AND model_base_url IS NULL AND model_policy_revision IS NULL)
        OR
        (role = 'lead-agent' AND model_provider IS NOT NULL AND model_id IS NOT NULL
          AND model_api IS NOT NULL AND model_base_url IS NOT NULL AND model_policy_revision IS NOT NULL)
      )
    ) STRICT;
  `);

  const readConfiguration = (): OwnerConfiguration | undefined => {
    const row = database
      .prepare(`
        SELECT target_project_path, model_provider, model_id, model_api,
               model_base_url, model_policy_revision
          FROM owner_configuration
         WHERE singleton_id = 1
      `)
      .get() as
      | {
          target_project_path: string;
          model_provider: string;
          model_id: string;
          model_api: "openai-completions";
          model_base_url: string;
          model_policy_revision: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      targetProject: { path: row.target_project_path },
      modelSelection: {
        provider: row.model_provider,
        model: row.model_id,
        api: row.model_api,
        baseUrl: row.model_base_url,
      },
      modelPolicyRevision: row.model_policy_revision,
    };
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
      const existing = readConfiguration();
      if (existing) {
        if (!sameConfiguration(existing, configuration)) {
          throw new Error("Authoritative state is already configured for a different Owner context.");
        }
        return;
      }
      database
        .prepare(`
          INSERT INTO owner_configuration (
            singleton_id, target_project_path, model_provider, model_id, model_api,
            model_base_url, model_policy_revision
          ) VALUES (1, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          configuration.targetProject.path,
          configuration.modelSelection.provider,
          configuration.modelSelection.model,
          configuration.modelSelection.api,
          configuration.modelSelection.baseUrl,
          configuration.modelPolicyRevision,
        );
    },

    readOwnerConversation() {
      const configuration = readConfiguration();
      if (!configuration) return undefined;
      const rows = database
        .prepare(`
          SELECT sequence, role, content, model_provider, model_id, model_api,
                 model_base_url, model_policy_revision
            FROM owner_conversation
           ORDER BY sequence
        `)
        .all() as Array<{
        sequence: number;
        role: "owner" | "lead-agent";
        content: string;
        model_provider: string | null;
        model_id: string | null;
        model_api: "openai-completions" | null;
        model_base_url: string | null;
        model_policy_revision: string | null;
      }>;
      const messages: ConversationMessage[] = rows.map((row) => {
        if (row.role === "owner") {
          return { sequence: row.sequence, role: row.role, content: row.content };
        }
        return {
          sequence: row.sequence,
          role: row.role,
          content: row.content,
          modelSelection: {
            provider: row.model_provider!,
            model: row.model_id!,
            api: row.model_api!,
            baseUrl: row.model_base_url!,
          },
          modelPolicyRevision: row.model_policy_revision!,
        };
      });
      return { ...configuration, messages };
    },

    appendOwnerMessage(content) {
      const configuration = readConfiguration();
      if (!configuration) throw new Error("Authoritative state is not configured.");
      database
        .prepare("INSERT INTO owner_conversation (role, content) VALUES ('owner', ?)")
        .run(content);
    },

    appendLeadAgentMessage(content) {
      const configuration = readConfiguration();
      if (!configuration) throw new Error("Authoritative state is not configured.");
      database
        .prepare(`
          INSERT INTO owner_conversation (
            role, content, model_provider, model_id, model_api, model_base_url,
            model_policy_revision
          ) VALUES ('lead-agent', ?, ?, ?, ?, ?, ?)
        `)
        .run(
          content,
          configuration.modelSelection.provider,
          configuration.modelSelection.model,
          configuration.modelSelection.api,
          configuration.modelSelection.baseUrl,
          configuration.modelPolicyRevision,
        );
    },

    close() {
      database.close();
    },
  };
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
