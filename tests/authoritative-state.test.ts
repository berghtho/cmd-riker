import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";

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
      },
      {
        sequence: 2,
        role: "lead-agent",
        content: "I will keep the canonical conversation here.",
        turnId,
        modelSelection: configuration.modelSelection,
        modelPolicyRevision: "owner-policy-1",
      },
    ],
  });
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
