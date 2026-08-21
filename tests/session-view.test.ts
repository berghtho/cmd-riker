import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSessionViewControl,
  projectSessionView,
  renderSessionItems,
  renderSessionView,
  renderSessionWorkers,
  type SessionViewState,
} from "../src/session-view/index.ts";
import type {
  Commitment,
  WorkerSession,
} from "../src/orchestration-core/index.ts";

function stateWith(overrides: Partial<Record<keyof SessionViewState, unknown>>): SessionViewState {
  return {
    readWorkerSessions: () => [],
    readWorkerExecutionAttempt: () => undefined,
    readWorkerQuestions: () => [],
    readEffectIntents: () => [],
    readCommitments: () => [],
    readCommitment: () => undefined,
    readCapabilityNotice: () => undefined,
    readForgeOwnerActionNotices: () => [],
    ...overrides,
  } as SessionViewState;
}

function worker(id: string, objective: string, state: WorkerSession["state"]): WorkerSession {
  return {
    id,
    assignment: {
      objective,
      prompt: "Do the work.",
      targetProjectPath: "C:\\target-project",
      readOnly: true,
      modelPolicyRevision: "worker-policy-1",
    },
    state,
    currentExecutionAttemptId: `${id}-attempt`,
  } as WorkerSession;
}

function item(id: string, outcome: string, extras: Partial<Commitment> = {}): Commitment {
  return {
    id,
    outcome,
    criteria: [],
    createdByOwnerTurnId: "turn-1",
    activeOwnerTurnId: "turn-1",
    state: "active",
    ...extras,
  } as Commitment;
}

test("the Session View shows plain numbered status without identifiers", () => {
  const snapshot = projectSessionView(stateWith({
    readWorkerSessions: () => [
      worker("11111111-aaaa-bbbb-cccc-dddddddddddd", "Implement CSV export", "running"),
      worker("22222222-aaaa-bbbb-cccc-dddddddddddd", "Review CSV export", "completed"),
    ],
    readCommitments: () => [
      item("33333333-aaaa-bbbb-cccc-dddddddddddd", "CSV export ships with column selection"),
    ],
  }));

  assert.equal(snapshot.activeWorkerCount, 1);
  const rendered = [
    renderSessionView(snapshot),
    renderSessionItems(snapshot),
    renderSessionWorkers(snapshot),
  ].join("\n");
  assert.doesNotMatch(rendered, /[0-9a-f]{8}-[0-9a-f]{4}/i);
  assert.match(rendered, /Implement CSV export/);
  assert.match(rendered, /CSV export ships with column selection/);
  assert.match(rendered, /1 item/);
});

test("the Session View carries item age and per-worker start times for the panel", () => {
  const startedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const running = {
    ...worker("11111111-aaaa-bbbb-cccc-dddddddddddd", "Implement CSV export", "running"),
  };
  (running.assignment as { commitmentId?: string }).commitmentId =
    "33333333-aaaa-bbbb-cccc-dddddddddddd";
  const snapshot = projectSessionView(stateWith({
    readWorkerSessions: () => [running],
    readWorkerExecutionAttempt: () => ({ process: { pid: 1, startedAt } }),
    readCommitments: () => [
      item("33333333-aaaa-bbbb-cccc-dddddddddddd", "CSV export ships with column selection"),
    ],
    commitmentRecordedAt: () => since,
  }));

  assert.equal(snapshot.workers[0]?.startedAt, startedAt);
  assert.equal(snapshot.workers[0]?.workItemId, "33333333-aaaa-bbbb-cccc-dddddddddddd");
  assert.equal(snapshot.items[0]?.since, since);
});

test("problems arrive as plain notices instead of an attention ledger", () => {
  const snapshot = projectSessionView(stateWith({
    readEffectIntents: () => [{
      id: "effect-1",
      commitmentId: "commitment-1",
      kind: "worker-assignment",
      workerSessionId: "worker-1",
      executionAttemptId: "attempt-1",
      expectedEffect: "Apply the change.",
      authorization: {
        kind: "lead-agent-command-authority",
        commitmentId: "commitment-1",
        targetProjectPath: "C:\\target-project",
        validatedAt: "2026-08-20T00:00:00.000Z",
      },
      retryRule: "Reconcile before replay.",
      status: "unknown",
    }],
    readCapabilityNotice: () => ({
      id: "codex-worker",
      state: "active",
      fingerprint: "codex-cli|ChatGPT|C:\\target-project|down",
      detail: "Codex authentication is unavailable.",
      targetProjectPath: "C:\\target-project",
      expectedIdentity: "ChatGPT",
      observedAt: "2026-08-20T00:00:00.000Z",
    }),
  }));

  assert.equal(snapshot.notices.length, 2);
  const rendered = renderSessionView(snapshot);
  assert.match(rendered, /needs reconciliation/);
  assert.match(rendered, /Codex authentication is unavailable/);
  assert.doesNotMatch(rendered, /[0-9a-f]{8}-[0-9a-f]{4}/i);
});

test("cancellation is addressed by worker number and only when available", () => {
  const running = worker("44444444-aaaa-bbbb-cccc-dddddddddddd", "Implement CSV export", "running");
  const snapshot = projectSessionView(
    stateWith({ readWorkerSessions: () => [running] }),
    { cancellationAvailable: true },
  );
  assert.deepEqual(parseSessionViewControl(snapshot, "/session cancel 1"), {
    kind: "cancel",
    workerSessionId: running.id,
  });
  assert.equal(parseSessionViewControl(snapshot, "/session cancel 2"), undefined);

  const withoutCancellation = projectSessionView(
    stateWith({ readWorkerSessions: () => [running] }),
    { cancellationAvailable: false },
  );
  assert.equal(parseSessionViewControl(withoutCancellation, "/session cancel 1"), undefined);
});

test("item status stays plain across the lifecycle", () => {
  const snapshot = projectSessionView(stateWith({
    readCommitments: () => [
      item("a1", "The bugfix ships", { state: "accepted" }),
      item("a2", "The feature ships", { state: "verifying" }),
      item("a3", "The refactor ships", {
        condition: {
          kind: "blocked",
          reason: "Tests failed.",
          nextAction: "Fix the tests.",
        },
      }),
      item("a4", "The cleanup ships", { state: "cancelled" }),
    ],
  }));

  assert.deepEqual(
    snapshot.items.map((entry) => entry.status),
    ["done", "verifying the result", "blocked"],
  );
  assert.equal(snapshot.items.length, 3);
});
