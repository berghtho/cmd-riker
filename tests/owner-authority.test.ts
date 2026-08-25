import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";

test("Owner controls migrate away from the observational Session View disposition", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-owner-authority-test-"));
  let state = openAuthoritativeState(stateDirectory);
  t.after(() => {
    state.close();
    return rm(stateDirectory, { recursive: true, force: true });
  });
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "lead-policy-1",
  });
  const legacyTurn = state.appendOwnerMessage("Legacy control");
  state.close();

  const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"));
  database.exec(`
    DROP TABLE owner_interaction_dispositions;
    CREATE TABLE owner_interaction_dispositions (
      owner_turn_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('session-view-control')),
      recorded_at TEXT NOT NULL
    ) STRICT;
  `);
  database.prepare(`
    INSERT INTO owner_interaction_dispositions (owner_turn_id, kind, recorded_at)
    VALUES (?, 'session-view-control', ?)
  `).run(legacyTurn, new Date().toISOString());
  database.close();

  state = openAuthoritativeState(stateDirectory);
  assert.equal(state.ownerInteractionDisposition(legacyTurn), "session-view-control");
  const ownerTurn = state.appendOwnerMessage("Revoke this authority");
  state.recordOwnerInteractionDisposition(ownerTurn, "owner-control");
  assert.equal(state.ownerInteractionDisposition(ownerTurn), "owner-control");
});
