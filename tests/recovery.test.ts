import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  openAuthoritativeState,
  openAuthoritativeStateSafely,
} from "../src/authoritative-state/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";
import type {
  TargetProjectOperationAttempt,
  TargetProjectOperationEffectIntent,
} from "../src/target-project-operations/index.ts";

test("external evidence reconciles an uncertain effect without reusing its attempt identity", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-effect-recovery-test-"));
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
  const ownerTurnId = state.appendOwnerMessage("Run the declared operation.");
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The declared operation is reconciled safely.",
    criteria: [
      {
        kind: "target-project-operation",
        description: "The effect is settled from external evidence.",
        operation: "test",
      },
    ],
  });
  const startedAt = "2026-08-19T14:00:00.000Z";
  const attempt = operationAttempt(commitment.id, "attempt-original", "effect-original", startedAt);
  const effect = effectIntent(commitment.id, attempt.id, "effect-original", startedAt);
  state.startTargetProjectOperation(attempt, effect);
  state.claimTargetProjectOperationDispatch(
    { ...attempt, status: "running" },
    {
      ...effect,
      status: "dispatching",
      lease: { claimedAt: startedAt, expiresAt: "2026-08-19T14:00:30.000Z" },
    },
  );
  state.close();

  state = openAuthoritativeState(stateDirectory);
  orchestration = createOrchestrationCore(state);
  orchestration.reconcileInterruptedCommitments();
  assert.equal(state.readEffectIntent(effect.id)?.status, "unknown");
  const uncertain = state.readEffectIntent(effect.id);
  if (uncertain?.kind !== "target-project-operation") assert.fail("Expected the original effect.");
  assert.throws(
    () =>
      state.reconcileEffectIntent({
        ...uncertain,
        operationAttemptId: "attempt-forged",
        status: "reconciled",
        reconciliation: {
          disposition: "confirmed-applied",
          evidence: {
            source: "target-project-readback",
            reference: "C:\\target-project\\test-report.json",
            summary: "Evidence must not be allowed to rewrite attribution.",
            observedAt: "2026-08-19T14:01:00.000Z",
          },
          reconciledAt: "2026-08-19T14:01:01.000Z",
          reconciledBy: "lead-agent",
        },
      }),
    /preserve the original effect identity and scope/,
  );
  assert.throws(
    () =>
      orchestration.reconcileEffect({
        effectIntentId: effect.id,
        disposition: "confirmed-applied",
        evidence: {
          source: "compensation-result",
          reference: "recovery-log://compensation-1",
          summary: "Compensation evidence cannot prove that the original effect was applied.",
          observedAt: "2026-08-19T14:01:00.000Z",
        },
      }),
    /compensation evidence.*does not prove.*confirmed-applied/i,
  );

  orchestration.reconcileEffect({
    effectIntentId: effect.id,
    disposition: "confirmed-applied",
    evidence: {
      source: "target-project-readback",
      reference: "C:\\target-project\\test-report.json",
      summary: "The attributed report proves the original operation completed.",
      observedAt: "2026-08-19T14:01:00.000Z",
    },
  });

  const reconciled = state.readEffectIntent(effect.id);
  assert.equal(reconciled?.status, "reconciled");
  assert.equal(reconciled?.reconciliation?.disposition, "confirmed-applied");
  assert.equal(reconciled?.reconciliation?.evidence.reference, "C:\\target-project\\test-report.json");

  const resumeTurnId = state.appendOwnerMessage("Continue with a fresh attempt.");
  orchestration.resumeCommitment(commitment.id, resumeTurnId);
  assert.equal(state.readCommitment(commitment.id)?.condition, undefined);

  assert.throws(
    () => state.startTargetProjectOperation(attempt, effect),
    /identities must be new/,
  );
  state.startTargetProjectOperation(
    operationAttempt(commitment.id, "attempt-replacement", "effect-replacement", startedAt),
    effectIntent(commitment.id, "attempt-replacement", "effect-replacement", startedAt),
  );
  state.close();
});

test("an uncertain effect blocks only conflicting risky effects while conversation and independent work continue", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-scoped-recovery-test-"));
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
  const ownerTurnId = state.appendOwnerMessage("Start the first effect.");
  const affected = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The first checkout is changed.",
    criteria: [{ kind: "target-project-operation", description: "Tests pass.", operation: "test" }],
  });
  const startedAt = "2026-08-19T14:00:00.000Z";
  const attempt = operationAttempt(affected.id, "attempt-uncertain", "effect-uncertain", startedAt);
  const effect = effectIntent(affected.id, attempt.id, "effect-uncertain", startedAt);
  const dispatchedEffect = {
    ...effect,
    status: "dispatching" as const,
    lease: { claimedAt: startedAt, expiresAt: "2026-08-19T14:00:30.000Z" },
  };
  state.startTargetProjectOperation(attempt, effect);
  state.claimTargetProjectOperationDispatch({ ...attempt, status: "running" }, dispatchedEffect);
  state.settleTargetProjectOperation(
    {
      ...attempt,
      status: "unknown",
      result: {
        operationAttemptId: attempt.id,
        effectIntentId: effect.id,
        commitmentId: affected.id,
        operation: "test",
        status: "unknown",
        discovery: attempt.discovery,
        affectedArtifacts: [],
        diagnostics: [{ source: "task-cli", stream: "host", message: "Continuity was lost." }],
        uncertainty: {
          reason: "Dispatch continuity was lost.",
          nextAction: "Read back the checkout before retrying.",
        },
        startedAt,
        completedAt: "2026-08-19T14:00:31.000Z",
      },
    },
    { ...dispatchedEffect, status: "unknown" },
  );

  const independentTurnId = state.appendOwnerMessage("Continue independent work.");
  const independent = orchestration.recordCommitment(independentTurnId, {
    outcome: "The independent checkout is changed.",
    criteria: [{ kind: "target-project-operation", description: "Tests pass.", operation: "test" }],
  });
  assert.doesNotThrow(() =>
    state.startTargetProjectOperation(
      operationAttempt(
        independent.id,
        "attempt-independent",
        "effect-independent",
        startedAt,
        "D:\\independent-project",
      ),
      effectIntent(
        independent.id,
        "attempt-independent",
        "effect-independent",
        startedAt,
        "D:\\independent-project",
      ),
    ),
  );

  const conflictingTurnId = state.appendOwnerMessage("Start a conflicting effect.");
  const conflicting = orchestration.recordCommitment(conflictingTurnId, {
    outcome: "The first checkout receives another change.",
    criteria: [{ kind: "target-project-operation", description: "Tests pass.", operation: "test" }],
  });
  assert.throws(
    () =>
      state.startTargetProjectOperation(
        operationAttempt(conflicting.id, "attempt-conflict", "effect-conflict", startedAt),
        effectIntent(conflicting.id, "attempt-conflict", "effect-conflict", startedAt),
      ),
    /conflicting Target Project effect/,
  );
  state.close();
});

test("damaged durable state opens an Owner-visible recovery surface with mutations disabled", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-damaged-state-test-"));
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
  state.close();
  const damagedBytes = Buffer.from("not a sqlite database\n", "utf8");
  await writeFile(join(stateDirectory, "authoritative-state.sqlite"), damagedBytes);

  const cli = await runCli(stateDirectory);
  assert.equal(cli.code, 2);
  assert.match(cli.stderr, /CMD_RIKER_STATE_RECOVERY_REQUIRED:/);
  assert.doesNotMatch(cli.stderr, /CMD_RIKER_HOST_FAILURE/);

  const opened = openAuthoritativeStateSafely(stateDirectory);
  assert.equal(opened.kind, "recovery-required");
  if (opened.kind !== "recovery-required") assert.fail("Damaged state must not open operationally.");
  assert.equal(opened.recovery.mutationPolicy, "disabled");
  assert.equal(opened.recovery.phase, "damaged-state");
  assert.match(opened.recovery.reason, /integrity|database|sqlite/i);
  assert.deepEqual(
    await readFile(join(opened.recovery.damagedEvidenceDirectory, "authoritative-state.sqlite")),
    damagedBytes,
  );
  assert.throws(
    () => openAuthoritativeState(stateDirectory),
    /recovery.*mutations.*disabled/i,
  );

  await writeFile(join(stateDirectory, "authoritative-state-recovery.json"), "{\"phase\":");
  const afterInterruptedRecoveryWrite = await runCli(stateDirectory);
  assert.equal(afterInterruptedRecoveryWrite.code, 2);
  assert.match(afterInterruptedRecoveryWrite.stderr, /CMD_RIKER_STATE_RECOVERY_REQUIRED:/);
  assert.doesNotMatch(afterInterruptedRecoveryWrite.stderr, /CMD_RIKER_HOST_FAILURE/);
});

test("restore preserves damaged evidence and blocks mutations until post-backup effects are reconciled", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-restore-test-"));
  const backupDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-state-backup-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  t.after(() => rm(backupDirectory, { recursive: true, force: true }));
  const backupPath = join(backupDirectory, "authoritative-state.sqlite");
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
  state.appendOwnerMessage("This message is inside the verified backup.");
  state.close();
  const backupResult = await runCli(stateDirectory, ["--create-state-backup", backupPath]);
  assert.equal(backupResult.code, 0, backupResult.stderr);
  assert.match(backupResult.stdout, /CMD_RIKER_STATE_BACKUP_CREATED:/);
  const backupManifest = JSON.parse(
    await readFile(`${backupPath}.manifest.json`, "utf8"),
  ) as { databasePath: string; sha256: string };
  assert.equal(backupManifest.databasePath, backupPath);
  assert.match(backupManifest.sha256, /^[a-f0-9]{64}$/);
  state = openAuthoritativeState(stateDirectory);
  state.appendOwnerMessage("This later message will not be restored.");
  state.close();

  const damagedBytes = Buffer.from("damaged after the backup\n", "utf8");
  await writeFile(join(stateDirectory, "authoritative-state.sqlite"), damagedBytes);
  const detected = openAuthoritativeStateSafely(stateDirectory);
  assert.equal(detected.kind, "recovery-required");
  if (detected.kind !== "recovery-required") assert.fail("Damage must enter recovery first.");

  const inventoryPath = join(backupDirectory, "post-backup-inventory.json");
  await writeFile(
    inventoryPath,
    JSON.stringify({
      assessedAt: "2026-08-19T14:10:00.000Z",
      source: "external-effect-inventory",
      reference: "recovery-log://empty-assertion",
      summary: "No later effects claimed without a completeness read-back.",
      effects: [],
    }),
  );
  const unprovedEmptyInventory = await runCli(stateDirectory, [
    "--restore-state-backup",
    backupPath,
    "--post-backup-inventory",
    inventoryPath,
  ]);
  assert.equal(unprovedEmptyInventory.code, 2);
  assert.match(unprovedEmptyInventory.stderr, /inventory is complete/);

  await writeFile(
    inventoryPath,
    JSON.stringify({
      assessedAt: "2026-08-19T14:10:00.000Z",
      source: "external-effect-inventory",
      reference: "recovery-log://attempt-42",
      summary: "One mutating operation may have occurred after the backup.",
      completenessEvidence: {
        source: "write-generation-and-effect-inventory-readback",
        reference: "recovery-log://generation-7-effects",
        summary: "The exclusive writer and effect ledger bound this complete inventory.",
        observedAt: "2026-08-19T14:10:00.000Z",
      },
      effects: [
        {
          id: "possible-effect-1",
          scope: "c:\\target-project",
          expectedEffect: "The post-backup Task operation may have changed the Target Project.",
        },
      ],
    }),
  );
  const unrelatedDatabasePath = join(backupDirectory, "unrelated.sqlite");
  const unrelatedDatabase = new DatabaseSync(unrelatedDatabasePath);
  unrelatedDatabase.exec("CREATE TABLE unrelated (value TEXT) STRICT;");
  unrelatedDatabase.close();
  const unrelatedSha256 = createHash("sha256")
    .update(await readFile(unrelatedDatabasePath))
    .digest("hex");
  await writeFile(
    `${unrelatedDatabasePath}.manifest.json`,
    JSON.stringify({
      version: 1,
      databasePath: unrelatedDatabasePath,
      sha256: unrelatedSha256,
      createdAt: "2026-08-19T14:09:00.000Z",
      lastJournalSequence: 0,
      backupId: "invented-backup",
      sourceStateId: "invented-state",
      writeGeneration: 1,
    }),
  );
  const unrelatedRestore = await runCli(stateDirectory, [
    "--restore-state-backup",
    unrelatedDatabasePath,
    "--post-backup-inventory",
    inventoryPath,
  ]);
  assert.equal(unrelatedRestore.code, 2);
  assert.match(unrelatedRestore.stderr, /CMD Riker backup provenance|CMD Riker schema/i);

  const restoreResult = await runCli(stateDirectory, [
    "--restore-state-backup",
    backupPath,
    "--post-backup-inventory",
    inventoryPath,
  ]);
  assert.equal(restoreResult.code, 0, restoreResult.stderr);
  assert.match(restoreResult.stdout, /CMD_RIKER_STATE_BACKUP_RESTORED:/);
  const restoredOpen = openAuthoritativeStateSafely(stateDirectory);
  assert.equal(restoredOpen.kind, "recovery-required");
  if (restoredOpen.kind !== "recovery-required") assert.fail("Restore must remain recovery-locked.");
  const restored = restoredOpen.recovery;
  assert.equal(restored.phase, "post-backup-reconciliation");
  assert.equal(restored.mutationPolicy, "disabled");
  assert.equal(restored.postBackupInventory?.effects.length, 1);
  assert.deepEqual(
    await readFile(join(restored.damagedEvidenceDirectory, "authoritative-state.sqlite")),
    damagedBytes,
  );
  const prematureCompletion = await runCli(stateDirectory, ["--complete-state-recovery"]);
  assert.equal(prematureCompletion.code, 2);
  assert.match(prematureCompletion.stderr, /possible-effect-1.*requires external evidence/);
  assert.throws(
    () => openAuthoritativeState(stateDirectory),
    /mutations are disabled/,
  );

  const reconciliationPath = join(backupDirectory, "effect-reconciliation.json");
  await writeFile(
    reconciliationPath,
    JSON.stringify({
      effectId: "possible-effect-1",
      disposition: "confirmed-not-applied",
      evidence: {
      source: "target-project-readback",
      reference: "C:\\target-project\\git-status.txt",
      summary: "The isolated checkout still matches the pre-dispatch baseline.",
      observedAt: "2026-08-19T14:11:00.000Z",
      },
    }),
  );
  const reconciliationResult = await runCli(stateDirectory, [
    "--reconcile-post-backup-effect",
    reconciliationPath,
  ]);
  assert.equal(reconciliationResult.code, 0, reconciliationResult.stderr);
  assert.match(reconciliationResult.stdout, /CMD_RIKER_POST_BACKUP_EFFECT_RECONCILED:/);
  const installedDatabase = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"));
  installedDatabase.exec("CREATE TABLE recovery_tamper (value TEXT) STRICT;");
  installedDatabase.close();
  const tamperedCompletion = await runCli(stateDirectory, ["--complete-state-recovery"]);
  assert.equal(tamperedCompletion.code, 2);
  assert.match(tamperedCompletion.stderr, /backup hash|integrity verification/i);

  const repeatedRestore = await runCli(stateDirectory, [
    "--restore-state-backup",
    backupPath,
    "--post-backup-inventory",
    inventoryPath,
  ]);
  assert.equal(repeatedRestore.code, 0, repeatedRestore.stderr);
  const repeatedReconciliation = await runCli(stateDirectory, [
    "--reconcile-post-backup-effect",
    reconciliationPath,
  ]);
  assert.equal(repeatedReconciliation.code, 0, repeatedReconciliation.stderr);
  const completionResult = await runCli(stateDirectory, ["--complete-state-recovery"]);
  assert.equal(completionResult.code, 0, completionResult.stderr);
  assert.match(completionResult.stdout, /CMD_RIKER_STATE_RECOVERY_COMPLETED:/);

  const opened = openAuthoritativeStateSafely(stateDirectory);
  assert.equal(opened.kind, "operational");
  if (opened.kind !== "operational") assert.fail("Reconciled restore must reopen operationally.");
  state = opened.state;
  assert.deepEqual(
    state.readOwnerConversation()?.messages.map((message) => message.content),
    ["This message is inside the verified backup."],
  );
  state.close();
});

test("Owner can explicitly establish a new baseline when no trusted backup exists", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-new-baseline-test-"));
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
  state.initialize(configuration);
  state.appendOwnerMessage("Damaged history must remain evidence.");
  state.close();
  await writeFile(join(stateDirectory, "authoritative-state.sqlite"), "damaged without backup\n");
  const detected = await runCli(stateDirectory);
  assert.equal(detected.code, 2);
  const recovery = openAuthoritativeStateSafely(stateDirectory);
  assert.equal(recovery.kind, "recovery-required");
  if (recovery.kind !== "recovery-required") assert.fail("Damage must remain visible.");
  await writeFile(join(stateDirectory, "config.json"), JSON.stringify(configuration));

  const established = await runCli(stateDirectory, [
    "--establish-new-state-baseline",
    "--owner-confirmation",
    "ESTABLISH-NEW-BASELINE",
  ]);
  assert.equal(established.code, 0, established.stderr);
  assert.match(established.stdout, /CMD_RIKER_NEW_STATE_BASELINE_ESTABLISHED:/);
  assert.deepEqual(
    await readFile(join(recovery.recovery.damagedEvidenceDirectory, "authoritative-state.sqlite")),
    Buffer.from("damaged without backup\n"),
  );
  state = openAuthoritativeState(stateDirectory);
  assert.deepEqual(state.readOwnerConversation()?.messages, []);
  assert.equal(state.readOwnerConversation()?.targetProject.path, "C:\\target-project");
  state.close();
});

function runCli(
  stateDirectory: string,
  extraArguments: readonly string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["src/cli.ts", "--state-dir", stateDirectory, ...extraArguments],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

function operationAttempt(
  commitmentId: string,
  attemptId: string,
  effectIntentId: string,
  startedAt: string,
  targetProjectPath = "C:\\target-project",
): TargetProjectOperationAttempt {
  return {
    id: attemptId,
    commitmentId,
    effectIntentId,
    operation: "test",
    checkout: targetProjectPath,
    workingDirectory: targetProjectPath,
    timeoutMs: 30_000,
    discovery: {
      status: "verified",
      checkout: { path: targetProjectPath, status: "verified" },
      platform: { name: "windows", status: "verified" },
      taskCli: { version: "Task version: v3.53.1", status: "verified" },
      taskfile: { path: `${targetProjectPath}\\Taskfile.yml`, status: "verified" },
      operation: { semantic: "test", task: "test", status: "verified" },
    },
    status: "ready",
    startedAt,
  };
}

function effectIntent(
  commitmentId: string,
  operationAttemptId: string,
  effectIntentId: string,
  startedAt: string,
  targetProjectPath = "C:\\target-project",
): TargetProjectOperationEffectIntent {
  return {
    id: effectIntentId,
    commitmentId,
    operationAttemptId,
    kind: "target-project-operation",
    expectedEffect: "Run the declared Target Project test operation.",
    authorizedWriteRootKey: targetProjectPath.toLowerCase(),
    authorization: {
      kind: "lead-agent-command-authority",
      commitmentId,
      targetProjectPath,
      validatedAt: startedAt,
    },
    retryRule: "Do not retry until external evidence settles the prior effect.",
    status: "pending",
  };
}
