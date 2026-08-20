import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import {
  advanceWriteGeneration,
  readWriteGenerationHighWater,
  recordWriteGenerationHighWater,
} from "../src/write-generation.ts";
import {
  createOrchestrationCore,
  defaultLeadModelRequirements,
} from "../src/orchestration-core/index.ts";

test("canonical Owner conversation and configuration survive close and reopen in WAL state", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));

  const configuration = {
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  };

  let state = openAuthoritativeState(stateDirectory);
  assert.deepEqual(state.storageStatus(), { journalMode: "wal" });
  state.initialize(configuration);
  const turnId = state.appendOwnerMessage("Remember this across restart.");
  assert.match(turnId, /^[0-9a-f-]{36}$/);
  state.appendLeadAgentMessage(turnId, "I will keep the canonical conversation here.");
  state.close();

  state = openAuthoritativeState(stateDirectory);
  assert.deepEqual(state.readOwnerConversation(), {
    ...configuration,
    messages: [
      {
        sequence: 1,
        role: "owner",
        content: "Remember this across restart.",
        turnId,
        modelSelection: configuration.modelSelection,
        modelPolicyRevision: "owner-policy-1",
        nativeHarness: null,
      },
      {
        sequence: 2,
        role: "lead-agent",
        content: "I will keep the canonical conversation here.",
        turnId,
        modelSelection: configuration.modelSelection,
        modelPolicyRevision: "owner-policy-1",
        nativeHarness: null,
      },
    ],
  });
  state.close();
});

test("generation transfer fences every stale Authoritative State writer", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-generation-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const configuration = {
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  };
  const stale = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });
  stale.initialize(configuration);
  const concurrentStale = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });

  assert.equal(advanceWriteGeneration(stateDirectory, 1), 2);
  assert.throws(
    () => stale.appendOwnerMessage("This stale process must not commit."),
    /write generation 1 is stale; active generation is 2/,
  );
  assert.throws(
    () => concurrentStale.replaceOwnerConfiguration({
      ...configuration,
      modelPolicyRevision: "stale-policy",
    }),
    /write generation 1 is stale; active generation is 2/,
  );
  await assert.rejects(
    stale.createBackup(join(stateDirectory, "stale-backup.sqlite")),
    /write generation 1 is stale; active generation is 2/,
  );
  stale.close();
  concurrentStale.close();

  const active = openAuthoritativeState(stateDirectory, { writeGeneration: 2 });
  assert.deepEqual(active.lifecycleStatus(), {
    schemaRevision: 1,
    writeGeneration: 2,
    journalMode: "wal",
    integrity: "passed",
  });
  assert.equal(active.readOwnerConversation()?.messages.length, 0);
  const liveDatabase = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"), {
    readOnly: true,
  });
  const stateIdentityColumns = liveDatabase
    .prepare("PRAGMA table_info(state_identity)")
    .all() as Array<{ name: string }>;
  assert.equal(stateIdentityColumns.some((column) => column.name === "write_generation"), false);
  liveDatabase.close();
  active.appendOwnerMessage("The active generation can commit.");
  const backup = await active.createBackup(join(stateDirectory, "generation-2-backup.sqlite"));
  assert.equal(backup.writeGeneration, 2);
  const backupDatabase = new DatabaseSync(backup.databasePath, { readOnly: true });
  const backupLifecycle = backupDatabase
    .prepare("SELECT write_generation FROM lifecycle_metadata WHERE singleton = 1")
    .get() as { write_generation: number };
  assert.equal(backupLifecycle.write_generation, 2);
  backupDatabase.close();
  active.close();

  assert.throws(
    () => advanceWriteGeneration(stateDirectory, 1),
    /expected write generation 1; found 2/,
  );
  const reopened = openAuthoritativeState(stateDirectory, { writeGeneration: 2 });
  assert.equal(reopened.readOwnerConversation()?.messages.length, 1);
  reopened.close();
  assert.equal(recordWriteGenerationHighWater(stateDirectory, 1), 2);
  assert.equal(readWriteGenerationHighWater(stateDirectory), 2);
});

test("a validated Lead Model policy activates atomically and preserves its ordered fallbacks", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-policy-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  const orchestration = createOrchestrationCore(state);
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "primary-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });

  const nextPolicy = {
    revision: "owner-policy-2",
    default: {
      provider: "local-openai",
      model: "new-primary",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11435/v1",
    },
    fallbacks: [
      {
        provider: "openai-codex" as const,
        model: "gpt-5.4-mini",
        api: "openai-codex-responses" as const,
      },
    ],
    requirements: defaultLeadModelRequirements,
  };
  orchestration.activateLeadModelPolicy(
    nextPolicy,
    [nextPolicy.default, ...nextPolicy.fallbacks].map((modelSelection) => ({
      modelSelection,
      requirements: defaultLeadModelRequirements,
      hardGates: {
        integration: "passed" as const,
        authentication: "passed" as const,
        intendedIdentity: "passed" as const,
        requiredCapabilities: "passed" as const,
        context: "passed" as const,
        dataHandling: "passed" as const,
        cost: "passed" as const,
      },
      availability: "passed" as const,
      observedAt: "2026-08-19T00:00:00.000Z",
    })),
  );
  assert.deepEqual(state.readOwnerConversation(), {
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "new-primary",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11435/v1",
    },
    modelFallbacks: [
      {
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        api: "openai-codex-responses",
      },
    ],
    modelRequirements: defaultLeadModelRequirements,
    modelPolicyRevision: "owner-policy-2",
    messages: [],
  });

  assert.throws(
    () =>
      orchestration.activateLeadModelPolicy(
        {
          revision: "owner-policy-invalid",
          default: {
            provider: "remote-provider",
            model: "forbidden",
            api: "openai-completions",
            baseUrl: "https://models.example.test/v1",
          },
          fallbacks: [],
          requirements: defaultLeadModelRequirements,
        },
        [],
      ),
    /must pass validation before policy activation/,
  );
  assert.equal(state.readOwnerConversation()?.modelPolicyRevision, "owner-policy-2");
  state.close();
});

test("an objective Commitment follows the evidence-gated lifecycle and survives restart", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-commitment-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  let orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Reply with Engage.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The Lead Agent replies with the requested phrase.",
    criteria: [
      {
        kind: "response-includes",
        description: "The response includes Engage.",
        expectedText: "Engage.",
      },
    ],
  });

  orchestration.observeLeadResponse(turnId, "Engage.");
  assert.deepEqual(
    state.readCommitmentHistory(commitment.id).map((entry) => entry.commitment.state),
    ["committed", "ready", "active", "verifying", "accepted"],
  );
  state.close();

  state = openAuthoritativeState(stateDirectory);
  orchestration = createOrchestrationCore(state);
  const restored = state.readCommitments()[0];
  assert.equal(restored?.id, commitment.id);
  assert.equal(restored?.state, "accepted");
  assert.equal(restored?.verification?.passed, true);
  assert.equal(restored?.acceptance?.authority, "lead-agent");
  assert.equal(restored?.acceptance?.basis, "objective-criteria");
  state.close();
});

test("a Lead response leaves an asynchronous Target Project Commitment active for operation evidence", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-async-commitment-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  const orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Implement and verify the requested change.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The Target Project change passes its declared tests.",
    criteria: [{
      kind: "target-project-operation",
      description: "The declared Target Project tests pass.",
      operation: "test",
    }],
  });

  orchestration.observeLeadResponse(turnId, "The Worker Session has started.");

  assert.deepEqual(state.readCommitment(commitment.id), commitment);
  state.close();
});

test("a reserved Commitment waits for a later Owner Acceptance", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-owner-acceptance-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  const orchestration = createOrchestrationCore(state);
  const earlierTurnId = state.appendOwnerMessage("This turn is too early to accept future work.");
  const creationTurnId = state.appendOwnerMessage("Draft a name I will judge.");
  const commitment = orchestration.recordCommitment(creationTurnId, {
    outcome: "A product name is proposed for Owner judgment.",
    criteria: [
      {
        kind: "owner-judgment",
      },
    ],
  });
  orchestration.observeLeadResponse(creationTurnId, "How about Riker?");
  assert.equal(state.readCommitments()[0]?.state, "awaiting-acceptance");
  assert.throws(
    () => orchestration.acceptCommitment(commitment.id, creationTurnId),
    /later Owner turn/,
  );
  assert.throws(
    () => orchestration.acceptCommitment(commitment.id, earlierTurnId),
    /later Owner turn/,
  );

  const acceptanceTurnId = state.appendOwnerMessage("I accept that name.");
  orchestration.acceptCommitment(commitment.id, acceptanceTurnId);
  const accepted = state.readCommitments()[0];
  assert.equal(accepted?.state, "accepted");
  assert.equal(accepted?.acceptance?.authority, "owner");
  assert.equal(accepted?.acceptance?.ownerTurnId, acceptanceTurnId);
  state.close();
});

test("a failed Lead turn leaves its active Commitment blocked with a recovery action", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-failed-turn-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  const orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Own this response even if the Model fails.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The Lead Agent supplies a response.",
    criteria: [
      {
        kind: "response-includes",
        description: "The response includes a result.",
        expectedText: "result",
      },
    ],
  });

  orchestration.observeLeadTurnFailure(turnId, "Lead Model turn failed: unavailable.");

  assert.deepEqual(state.readCommitment(commitment.id)?.condition, {
    kind: "blocked",
    reason: "Lead Model turn failed: unavailable.",
    nextAction: "Reconcile the failed Lead turn before continuing this Commitment.",
  });
  orchestration.recordCommitmentOwnerAttention(commitment.id, {
    kind: "mission-critical-impairment",
    reason: "The failed Lead turn now blocks the mission-critical outcome.",
    nextAction: "The Owner must choose whether to retry with a different Model.",
  });
  assert.equal(
    state.readCommitment(commitment.id)?.condition?.ownerAttention,
    "mission-critical-impairment",
  );
  const recoveryTurnId = state.appendOwnerMessage("Resume that Commitment now.");
  orchestration.resumeCommitment(commitment.id, recoveryTurnId);
  orchestration.observeLeadResponse(recoveryTurnId, "Recovered result");
  assert.equal(state.readCommitment(commitment.id)?.state, "accepted");
  state.close();
});

test("Owner controls can pause, resume, and cancel a nonterminal Commitment", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-control-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  const orchestration = createOrchestrationCore(state);
  const creationTurnId = state.appendOwnerMessage("Own a controllable outcome.");
  const commitment = orchestration.recordCommitment(creationTurnId, {
    outcome: "A controllable outcome is delivered.",
    criteria: [
      {
        kind: "response-includes",
        description: "The result is delivered.",
        expectedText: "result",
      },
    ],
  });
  const pauseTurnId = state.appendOwnerMessage("Pause it.");
  orchestration.pauseCommitment(commitment.id, pauseTurnId, "Owner requested a pause.");
  assert.equal(state.readCommitment(commitment.id)?.condition?.kind, "paused");
  const resumeTurnId = state.appendOwnerMessage("Resume it.");
  orchestration.resumeCommitment(commitment.id, resumeTurnId);
  assert.equal(state.readCommitment(commitment.id)?.condition, undefined);
  const cancelTurnId = state.appendOwnerMessage("Cancel it.");
  orchestration.cancelCommitment(commitment.id, cancelTurnId, "Owner cancelled the outcome.");
  const cancelled = state.readCommitment(commitment.id);
  assert.equal(cancelled?.state, "cancelled");
  assert.deepEqual(cancelled?.disposition, {
    kind: "cancelled",
    reason: "Owner cancelled the outcome.",
    ownerTurnId: cancelTurnId,
  });
  state.close();
});

test("restart marks an interrupted active Commitment as reconciling until resume", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-reconcile-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  let orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Start work before restart.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The interrupted outcome is recovered.",
    criteria: [
      {
        kind: "response-includes",
        description: "The response confirms recovery.",
        expectedText: "Recovered",
      },
    ],
  });
  state.close();

  state = openAuthoritativeState(stateDirectory);
  orchestration = createOrchestrationCore(state);
  orchestration.reconcileInterruptedCommitments();
  assert.deepEqual(state.readCommitment(commitment.id)?.condition, {
    kind: "reconciling",
    reason: "Host restart lost continuity with the active Lead turn.",
    nextAction: "Resume this Commitment in a new attributed Owner turn.",
  });
  state.close();
});

test("restart settles a started attempt from its already persisted Lead response", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-response-reconcile-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let state = openAuthoritativeState(stateDirectory);
  const configuration = {
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  };
  state.initialize(configuration);
  let orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage("Persist the response before settlement.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "The persisted response is accepted after reconciliation.",
    criteria: [
      {
        kind: "response-includes",
        description: "The response confirms recovery.",
        expectedText: "Recovered",
      },
    ],
  });
  const attempt = orchestration.startLeadTurnAttempt({
    ownerTurnId: turnId,
    modelSelection: configuration.modelSelection,
    modelPolicyRevision: configuration.modelPolicyRevision,
  });
  state.appendLeadAgentMessage(turnId, "Recovered");
  state.close();

  state = openAuthoritativeState(stateDirectory);
  orchestration = createOrchestrationCore(state);
  orchestration.reconcileInterruptedCommitments();
  assert.equal(state.readCommitment(commitment.id)?.state, "accepted");
  assert.equal(state.readLeadTurnAttempt(attempt.id)?.status, "completed");
  assert.equal(state.readLeadTurnAttempt(attempt.id)?.failureKind, undefined);
  state.close();
});

test("opening first-slice state migrates its typed fact table without losing conversation", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-migration-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"));
  database.exec(`
    CREATE TABLE facts (
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
    CREATE UNIQUE INDEX facts_one_successor
      ON facts(supersedes_fact_id) WHERE supersedes_fact_id IS NOT NULL;
    CREATE TABLE transitions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      fact_id TEXT NOT NULL UNIQUE REFERENCES facts(id),
      recorded_at TEXT NOT NULL
    ) STRICT;
  `);
  database
    .prepare(`
      INSERT INTO facts (id, subject_id, kind, value_json, supersedes_fact_id, recorded_at)
      VALUES (?, 'owner:primary', 'owner.configuration', ?, NULL, ?)
    `)
    .run(
      "configuration-fact",
      JSON.stringify({
        targetProject: { path: "C:\\target-project" },
        modelSelection: {
          provider: "local-openai",
          model: "owner-model",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
        modelPolicyRevision: "owner-policy-1",
      }),
      "2026-08-19T00:00:00.000Z",
    );
  database
    .prepare(`
      INSERT INTO transitions (id, kind, fact_id, recorded_at)
      VALUES ('configuration-transition', 'owner.configuration-recorded', 'configuration-fact', ?)
    `)
    .run("2026-08-19T00:00:00.000Z");
  database.close();

  const state = openAuthoritativeState(stateDirectory);
  const orchestration = createOrchestrationCore(state);
  assert.equal(state.readOwnerConversation()?.modelPolicyRevision, "owner-policy-1");
  const turnId = state.appendOwnerMessage("Create a Commitment after migration.");
  const commitment = orchestration.recordCommitment(turnId, {
    outcome: "Migration supports new facts.",
    criteria: [
      {
        kind: "response-includes",
        description: "The response confirms migration.",
        expectedText: "Migrated.",
      },
    ],
  });
  assert.equal(commitment.state, "active");
  state.close();
});

test("initialization is idempotent but cannot replace the one active Target Project", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-config-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  state.close();

  state = openAuthoritativeState(stateDirectory);
  assert.doesNotThrow(() =>
    state.initialize({
      modelPolicyRevision: "owner-policy-1",
      targetProject: { path: "C:\\target-project" },
      modelSelection: {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        model: "owner-model",
        provider: "local-openai",
      },
    }),
  );
  assert.doesNotThrow(() =>
    state.initialize({
      targetProject: { path: "C:\\target-project" },
      forgeAuthorities: {
        github: { account: "owner-login", repository: "owner/repository" },
      },
      modelSelection: {
        provider: "local-openai",
        model: "owner-model",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
      modelPolicyRevision: "owner-policy-1",
    }),
  );
  assert.deepEqual(state.readOwnerConversation()?.forgeAuthorities, {
    github: { account: "owner-login", repository: "owner/repository" },
  });
  assert.throws(
    () =>
      state.initialize({
        targetProject: { path: "C:\\different-project" },
        modelSelection: {
          provider: "local-openai",
          model: "owner-model",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
        modelPolicyRevision: "owner-policy-1",
      }),
    /already configured for a different Owner context/,
  );
  state.close();
});

test("authoritative state refuses to persist a Model URL that can carry secrets", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-secret-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory);

  assert.throws(
    () =>
      state.initialize({
        targetProject: { path: "C:\\target-project" },
        modelSelection: {
          provider: "local-openai",
          model: "owner-model",
          api: "openai-completions",
          baseUrl: "http://token@127.0.0.1:11434/v1",
        },
        modelPolicyRevision: "owner-policy-1",
      }),
    /must not contain credentials, query parameters, or fragments/,
  );
  assert.equal(state.readOwnerConversation(), undefined);
  state.close();
});
