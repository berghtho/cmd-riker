import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { assessHostHealth } from "../src/host-health.ts";

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

test("candidate health proves exact identity, durable context, generation, probe, and handshake", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-health-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });
  state.initialize(configuration);
  state.close();

  const assessment = assessHostHealth({
    stateDirectory,
    expectedWriteGeneration: 1,
    expectedAttemptId: "attempt-1",
    reportedAttemptId: "attempt-1",
    expectedCandidateRevision: "riker-2",
    reportedCandidateRevision: "riker-2",
    expectedArtifactDigest: "a".repeat(64),
    observedArtifactDigest: "a".repeat(64),
    expectedHandshakeNonce: "handshake-1",
    reportedHandshakeNonce: "handshake-1",
    observedAt: "2026-08-20T10:01:00.000Z",
  });

  assert.equal(assessment.verdict, "healthy");
  assert.deepEqual(assessment.checks, {
    exactIdentity: "passed",
    artifactIntegrity: "passed",
    authoritativeState: "passed",
    writeGeneration: "passed",
    conversationContext: "passed",
    writeReadProbe: "passed",
    recoveryHandshake: "passed",
    activationBarrier: "passed",
  });
});

test("health is impaired while Owner input remains unprocessed and does not claim process presence", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-health-barrier-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });
  state.initialize(configuration);
  state.appendOwnerMessage("Do not acknowledge this turn across cutover.");
  state.close();

  const assessment = assessHostHealth({
    stateDirectory,
    expectedWriteGeneration: 1,
    expectedAttemptId: "attempt-1",
    reportedAttemptId: "attempt-1",
    expectedCandidateRevision: "riker-2",
    reportedCandidateRevision: "riker-2",
    expectedArtifactDigest: "a".repeat(64),
    observedArtifactDigest: "a".repeat(64),
    expectedHandshakeNonce: "handshake-1",
    reportedHandshakeNonce: "handshake-1",
    observedAt: "2026-08-20T10:01:00.000Z",
  });

  assert.equal(assessment.verdict, "impaired");
  assert.equal(assessment.checks.activationBarrier, "failed");
  assert.match(assessment.evidence.join("\n"), /unanswered Owner turn/);
  assert.doesNotMatch(JSON.stringify(assessment), /process.*running|port.*listening/i);
});

test("a terminally failed Lead turn does not block later activation forever", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-health-failed-turn-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });
  state.initialize(configuration);
  const ownerTurnId = state.appendOwnerMessage("This turn loses continuity after durable failure.");
  state.appendLeadTurnAttemptSnapshots([{
    id: "failed-attempt-1",
    ownerTurnId,
    modelSelection: configuration.modelSelection,
    modelPolicyRevision: configuration.modelPolicyRevision,
    nativeHarness: null,
    status: "failed",
    failureKind: "continuity-lost",
  }]);
  state.close();

  const assessment = assessHostHealth({
    stateDirectory,
    expectedWriteGeneration: 1,
    expectedAttemptId: "attempt-1",
    reportedAttemptId: "attempt-1",
    expectedCandidateRevision: "riker-2",
    reportedCandidateRevision: "riker-2",
    expectedArtifactDigest: "a".repeat(64),
    observedArtifactDigest: "a".repeat(64),
    expectedHandshakeNonce: "handshake-1",
    reportedHandshakeNonce: "handshake-1",
    observedAt: "2026-08-20T10:01:00.000Z",
  });

  assert.equal(assessment.verdict, "healthy");
  assert.equal(assessment.checks.activationBarrier, "passed");
});

test("a dispositioned Session View control is not treated as an unanswered Lead turn", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-health-session-control-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });
  state.initialize(configuration);
  const ownerTurnId = state.appendOwnerMessage("/session pause commitment-1");
  state.recordOwnerInteractionDisposition(ownerTurnId, "session-view-control");
  state.close();

  const assessment = assessHostHealth({
    stateDirectory,
    expectedWriteGeneration: 1,
    expectedAttemptId: "attempt-1",
    reportedAttemptId: "attempt-1",
    expectedCandidateRevision: "riker-2",
    reportedCandidateRevision: "riker-2",
    expectedArtifactDigest: "a".repeat(64),
    observedArtifactDigest: "a".repeat(64),
    expectedHandshakeNonce: "handshake-1",
    reportedHandshakeNonce: "handshake-1",
    observedAt: "2026-08-20T10:01:00.000Z",
  });

  assert.equal(assessment.verdict, "healthy");
  assert.equal(assessment.checks.activationBarrier, "passed");
});

test("Session View syntax without a durable control disposition still blocks cutover", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-health-session-pending-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });
  state.initialize(configuration);
  state.appendOwnerMessage("/session pause commitment-1");
  state.close();

  const assessment = assessHostHealth({
    stateDirectory,
    expectedWriteGeneration: 1,
    expectedAttemptId: "attempt-1",
    reportedAttemptId: "attempt-1",
    expectedCandidateRevision: "riker-2",
    reportedCandidateRevision: "riker-2",
    expectedArtifactDigest: "a".repeat(64),
    observedArtifactDigest: "a".repeat(64),
    expectedHandshakeNonce: "handshake-1",
    reportedHandshakeNonce: "handshake-1",
    observedAt: "2026-08-20T10:01:00.000Z",
  });

  assert.equal(assessment.verdict, "impaired");
  assert.match(assessment.evidence.join("\n"), /unanswered Owner turn/);
});

test("a stale generation produces unknown health without committing the probe", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-health-stale-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });
  state.initialize(configuration);
  state.close();

  const assessment = assessHostHealth({
    stateDirectory,
    expectedWriteGeneration: 2,
    expectedAttemptId: "attempt-1",
    reportedAttemptId: "attempt-1",
    expectedCandidateRevision: "riker-2",
    reportedCandidateRevision: "riker-2",
    expectedArtifactDigest: "a".repeat(64),
    observedArtifactDigest: "a".repeat(64),
    expectedHandshakeNonce: "handshake-1",
    reportedHandshakeNonce: "handshake-1",
    observedAt: "2026-08-20T10:01:00.000Z",
  });

  assert.equal(assessment.verdict, "unknown");
  assert.equal(assessment.checks.writeGeneration, "failed");
  assert.match(assessment.evidence.join("\n"), /generation 2 is stale/);
});
