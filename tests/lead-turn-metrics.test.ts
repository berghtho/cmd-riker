import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import {
  projectSessionView,
  renderLeadTurnMetrics,
  type SessionViewState,
} from "../src/session-view/index.ts";
import type { LeadTurnMetrics } from "../src/model-selection.ts";

function ownerConfiguration() {
  return {
    targetProject: { path: "C:\\target-project" },
    projects: [{ name: "second", path: "C:\\second-project" }],
    modelSelection: {
      provider: "local-openai" as const,
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "lead-policy-1",
  };
}

function metrics(overrides: Partial<LeadTurnMetrics> = {}): LeadTurnMetrics {
  return {
    provider: "local-openai",
    model: "owner-model",
    contextTokens: 42_000,
    contextWindow: 131_072,
    ...overrides,
  };
}

test("Lead turn metrics attribute the completed turn durably and survive restart", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-lead-metrics-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let state = openAuthoritativeState(stateDirectory);
  state.initialize(ownerConfiguration());

  // Before any completed turn, the configured selection is shown without
  // context evidence: nothing is estimated.
  const configured = state.readLatestLeadTurnMetrics();
  assert.equal(configured?.model, "owner-model");
  assert.equal(configured?.contextTokens, 0);
  assert.equal(configured?.contextWindow, null);

  const turnId = state.appendOwnerMessage("Report status.");
  state.appendLeadAgentMessage(turnId, "All quiet.", {
    modelSelection: ownerConfiguration().modelSelection,
    modelPolicyRevision: "lead-policy-1",
    turnMetrics: metrics(),
  });

  assert.deepEqual(state.readLatestLeadTurnMetrics(), metrics());
  const message = state.readOwnerConversation()?.messages.at(-1);
  assert.equal(message?.role, "lead-agent");
  assert.deepEqual(
    message?.role === "lead-agent" ? message.turnMetrics : undefined,
    metrics(),
  );

  state.close();
  state = openAuthoritativeState(stateDirectory);
  assert.deepEqual(state.readLatestLeadTurnMetrics(), metrics());
  state.close();
});

test("the Session View snapshot carries the Lead's metrics for the Owner UI", () => {
  const state = {
    readWorkerSessions: () => [],
    readWorkerExecutionAttempt: () => undefined,
    readWorkerQuestions: () => [],
    readEffectIntents: () => [],
    readCommitments: () => [],
    readCommitment: () => undefined,
    readCapabilityNotice: () => undefined,
    readForgeOwnerActionNotices: () => [],
    readLatestLeadTurnMetrics: () => metrics({ thinkingLevel: "high" }),
  } as SessionViewState;

  const snapshot = projectSessionView(state);
  assert.deepEqual(snapshot.lead, metrics({ thinkingLevel: "high" }));
});

test("scoped Session Views use metrics from their active Owner Session", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-scoped-lead-metrics-test-"));
  const state = openAuthoritativeState(stateDirectory);
  t.after(() => {
    state.close();
    return rm(stateDirectory, { recursive: true, force: true });
  });
  state.initialize(ownerConfiguration());
  const primaryTurn = state.appendOwnerMessage("Default project status.");
  state.appendLeadAgentMessage(primaryTurn, "Default result.", {
    modelSelection: ownerConfiguration().modelSelection,
    modelPolicyRevision: "lead-policy-1",
    turnMetrics: metrics({ contextTokens: 10_000 }),
  });
  state.appendOwnerSessionSnapshots([{
    id: "second-session",
    name: "Second project status",
    createdAt: "2026-08-26T00:00:00.000Z",
    projectPath: "C:\\second-project",
    state: "active",
  }]);
  const secondTurn = state.appendOwnerMessage("Second project status.", "second-session");
  state.appendLeadAgentMessage(secondTurn, "Second result.", {
    modelSelection: ownerConfiguration().modelSelection,
    modelPolicyRevision: "lead-policy-1",
    turnMetrics: metrics({ contextTokens: 20_000 }),
  });

  assert.equal(state.readLatestLeadTurnMetrics("primary")?.contextTokens, 10_000);
  assert.equal(state.readLatestLeadTurnMetrics("second-session")?.contextTokens, 20_000);
  assert.equal(projectSessionView(state, {
    activeSessionId: "primary",
    targetProjectPath: "C:\\target-project",
  }).lead?.contextTokens, 10_000);
  assert.equal(projectSessionView(state, {
    activeSessionId: "second-session",
    targetProjectPath: "C:\\second-project",
  }).lead?.contextTokens, 20_000);
});

test("Lead metrics render as model, effort, and context in k tokens with percent", () => {
  assert.equal(
    renderLeadTurnMetrics(metrics({ model: "gpt-5-codex", thinkingLevel: "xhigh" })),
    "gpt-5-codex xhigh · 42k/131k (32%)",
  );
  // Without measured context there is nothing honest to show beyond the model.
  assert.equal(
    renderLeadTurnMetrics(metrics({ contextTokens: 0, contextWindow: null })),
    "owner-model",
  );
  assert.equal(
    renderLeadTurnMetrics(metrics({ contextTokens: 131_072 })),
    "owner-model · 131k/131k (100%)",
  );
});
