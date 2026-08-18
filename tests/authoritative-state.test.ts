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
  state.appendOwnerMessage("Remember this across restart.");
  state.appendLeadAgentMessage("I will keep the canonical conversation here.");
  state.close();

  state = openAuthoritativeState(stateDirectory);
  assert.deepEqual(state.readOwnerConversation(), {
    ...configuration,
    messages: [
      { sequence: 1, role: "owner", content: "Remember this across restart." },
      {
        sequence: 2,
        role: "lead-agent",
        content: "I will keep the canonical conversation here.",
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
