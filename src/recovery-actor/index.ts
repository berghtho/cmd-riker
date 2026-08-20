import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RecoveryActorIdentity = {
  revision: string;
  digest: string;
  path: string;
};

export type CodeStatePair = {
  code: {
    revision: string;
    digest: string;
    path: string;
    runtime: { version: string; architecture: "x64" | "arm64" };
  };
  state: {
    revision: string;
    digest: string;
    snapshotPath: string;
  };
};

export type HealthAssessment = {
  verdict: "healthy" | "impaired" | "unavailable" | "unknown";
  subject: string;
  scope: string;
  observedAt: string;
  evidence: string[];
};

export type RecoveryPolicyIdentity = { revision: string; digest: string };

export const protectedRecoveryPolicyIdentity: RecoveryPolicyIdentity = Object.freeze({
  revision: "recovery-policy-v1",
  digest: createHash("sha256")
    .update("fixed-health-v1|single-cutover-v1|rollback-before-retry-v1|no-baseline-promotion-v1")
    .digest("hex"),
});

export type ActivationAuthority =
  | { kind: "owner-supplied-upgrade"; authorizedAt: string }
  | {
      kind: "lead-agent-self-repair";
      selfRepairId: string;
      selfRepairAttemptId: string;
      commitmentId: string;
      recoveryActorRevision: string;
      recoveryActorDigest: string;
      recoveryActorPath: string;
      recoveryPolicyRevision: string;
      recoveryPolicyDigest: string;
      authorizedAt: string;
    };

export const requiredActivationHealthCriteria = [
  "exact-identity",
  "artifact-integrity",
  "authoritative-state",
  "write-generation",
  "conversation-context",
  "write-read-probe",
  "recovery-handshake",
] as const;

export type ActivationPhase =
  | "authorized"
  | "snapshot-pending"
  | "snapshot-complete"
  | "generation-transfer-pending"
  | "generation-transferred"
  | "candidate-launch-pending"
  | "health-handshake"
  | "probation"
  | "activated"
  | "rollback-required"
  | "rollback-restore-pending"
  | "rolled-back";

export type ActivationAttempt = {
  id: string;
  actor: RecoveryActorIdentity;
  candidate: CodeStatePair;
  baseline: CodeStatePair;
  writeGeneration: number;
  phase: ActivationPhase;
  authority: ActivationAuthority;
  compatibility: { stateSchema: "lossless-return-proven"; evidence: string };
  verification: { verdict: "passed"; evidence: string[] };
  review: { verdict: "passed"; evidence: string[] };
  healthCriteria: string[];
  budget: { deadline: string; probationChecks: number };
  recoveryPath: "restore-exact-baseline-pair";
  process?: { pid: number; startedAt: string; nonce: string };
  health?: HealthAssessment;
  failure?: string;
};

export interface ActivationEffects {
  verifyCandidate(candidate: CodeStatePair, actor: RecoveryActorIdentity): Promise<void>;
  verifyRecoveryBaseline(baseline: CodeStatePair): Promise<HealthAssessment>;
  assessBarrier(): Promise<{ ready: boolean; blockers: string[] }>;
  snapshotState(baseline: CodeStatePair, attemptId: string): Promise<void>;
  transferWriteGeneration(expected: number): Promise<number>;
  currentWriteGeneration(): Promise<number>;
  launch(
    pair: CodeStatePair,
    context: { attemptId: string; writeGeneration: number; nonce: string },
  ): Promise<{ pid: number; startedAt: string; nonce: string }>;
  assessHealth(
    pair: CodeStatePair,
    context: {
      attemptId: string;
      writeGeneration: number;
      process: { pid: number; startedAt: string; nonce: string };
      criteria: string[];
    },
  ): Promise<HealthAssessment>;
  awaitProbation(
    pair: CodeStatePair,
    context: {
      attemptId: string;
      writeGeneration: number;
      process: { pid: number; startedAt: string; nonce: string };
      checks: number;
      deadline: string;
    },
  ): Promise<HealthAssessment>;
  terminate(process: { pid: number; startedAt: string; nonce: string }): Promise<void>;
  restoreBaseline(pair: CodeStatePair, failedGeneration: number): Promise<number>;
  restoredBaselineGeneration(pair: CodeStatePair, failedGeneration: number): Promise<number | undefined>;
}

type Installation = {
  actor: RecoveryActorIdentity;
  active: CodeStatePair;
  recoveryBaseline: CodeStatePair;
  writeGeneration: number;
  currentAttemptId?: string;
  leadRestartBudget: {
    revision: string;
    limit: number;
    remaining: number;
    failures: Array<{ observedAt: string; detail: string }>;
  };
};

export interface RecoveryActor {
  initialize(input: {
    active: CodeStatePair;
    recoveryBaseline: CodeStatePair;
    writeGeneration: number;
  }): void;
  activate(input: Omit<ActivationAttempt, "id" | "actor" | "baseline" | "writeGeneration" | "phase" | "process" | "health" | "failure"> & {
    baseline?: CodeStatePair;
  }): Promise<{
    attemptId: string;
    outcome: "activated" | "rolled-back";
  }>;
  recover(): Promise<{
    attemptId?: string;
    outcome: "unchanged" | "rolled-back";
  }>;
  resetLeadRestartBudget(limit: number): void;
  recordLeadFailure(revision: string, detail: string): { remaining: number; exhausted: boolean };
  inspect(): {
    actor?: RecoveryActorIdentity;
    active?: CodeStatePair;
    recoveryBaseline?: CodeStatePair;
    writeGeneration?: number;
    currentAttempt?: ActivationAttempt;
    leadRestartBudget?: Installation["leadRestartBudget"];
  };
  inspectSelfRepairAttempt(selfRepairId: string, selfRepairAttemptId: string): ActivationAttempt | undefined;
  close(): void;
}

export function openRecoveryActor(
  installRoot: string,
  actorIdentity: RecoveryActorIdentity,
  effects: ActivationEffects,
): RecoveryActor {
  mkdirSync(installRoot, { recursive: true });
  const database = new DatabaseSync(join(installRoot, "activation-journal.sqlite"));
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  ensureSchema(database);

  const readInstallation = (): Installation | undefined => {
    const row = database.prepare("SELECT value_json FROM installation WHERE singleton = 1").get() as
      | { value_json: string }
      | undefined;
    return row ? JSON.parse(row.value_json) as Installation : undefined;
  };

  const readAttempt = (id: string): ActivationAttempt | undefined => {
    const row = database.prepare("SELECT value_json FROM activation_attempts WHERE id = ?").get(id) as
      | { value_json: string }
      | undefined;
    return row ? JSON.parse(row.value_json) as ActivationAttempt : undefined;
  };

  const recordAttempt = (
    attempt: ActivationAttempt,
    installationUpdate?: Partial<Pick<Installation, "active" | "writeGeneration">>,
  ): void => {
    const installation = requireInstallation(readInstallation());
    const updatedInstallation: Installation = {
      ...installation,
      ...installationUpdate,
      currentAttemptId: attempt.id,
      ...(installationUpdate?.active &&
      installationUpdate.active.code.revision !== installation.leadRestartBudget.revision
        ? {
            leadRestartBudget: {
              revision: installationUpdate.active.code.revision,
              limit: installation.leadRestartBudget.limit,
              remaining: installation.leadRestartBudget.limit,
              failures: [],
            },
          }
        : {}),
    };
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(`
          INSERT INTO activation_attempts (id, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `)
        .run(attempt.id, JSON.stringify(attempt), new Date().toISOString());
      database
        .prepare(`
          INSERT INTO activation_transitions (attempt_id, phase, value_json, recorded_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(attempt.id, attempt.phase, JSON.stringify(attempt), new Date().toISOString());
      database
        .prepare("UPDATE installation SET value_json = ? WHERE singleton = 1")
        .run(JSON.stringify(updatedInstallation));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const recordNewAttempt = (attempt: ActivationAttempt): void => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const installation = requireInstallation(readInstallation());
      const current = installation.currentAttemptId
        ? readAttempt(installation.currentAttemptId)
        : undefined;
      if (current && !["activated", "rolled-back"].includes(current.phase)) {
        throw new Error(`Activation Attempt ${current.id} is still in progress.`);
      }
      database
        .prepare("INSERT INTO activation_attempts (id, value_json, updated_at) VALUES (?, ?, ?)")
        .run(attempt.id, JSON.stringify(attempt), new Date().toISOString());
      database
        .prepare(`
          INSERT INTO activation_transitions (attempt_id, phase, value_json, recorded_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(attempt.id, attempt.phase, JSON.stringify(attempt), new Date().toISOString());
      database
        .prepare("UPDATE installation SET value_json = ? WHERE singleton = 1")
        .run(JSON.stringify({ ...installation, currentAttemptId: attempt.id }));
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const transition = (
    attempt: ActivationAttempt,
    phase: ActivationPhase,
    additions: Partial<Pick<ActivationAttempt, "process" | "health" | "failure">> = {},
    installationUpdate?: Partial<Pick<Installation, "active" | "writeGeneration">>,
  ): ActivationAttempt => {
    const next = { ...attempt, ...additions, phase };
    recordAttempt(next, installationUpdate);
    return next;
  };

  return {
    initialize(input) {
      validateActor(actorIdentity);
      validatePair(input.active);
      validatePair(input.recoveryBaseline);
      if (!Number.isSafeInteger(input.writeGeneration) || input.writeGeneration < 1) {
        throw new Error("Initial write generation must be a positive integer.");
      }
      const existing = readInstallation();
      const installation: Installation = {
        actor: actorIdentity,
        ...input,
        leadRestartBudget: {
          revision: input.active.code.revision,
          limit: 3,
          remaining: 3,
          failures: [],
        },
      };
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(installation)) {
          throw new Error("Recovery Actor is already initialized with a different installation.");
        }
        return;
      }
      database
        .prepare("INSERT INTO installation (singleton, value_json) VALUES (1, ?)")
        .run(JSON.stringify(installation));
    },

    async activate(input) {
      const installation = requireInstallation(readInstallation());
      if (!sameActor(installation.actor, actorIdentity)) {
        throw new Error("The active Recovery Actor identity does not match its protected journal.");
      }
      validateActivationInput(input, actorIdentity);
      if (
        input.authority.kind === "lead-agent-self-repair" &&
        (!input.baseline ||
          !sameCode(input.baseline.code, installation.recoveryBaseline.code) ||
          JSON.stringify(input.baseline.state) !== JSON.stringify(input.candidate.state))
      ) {
        throw new Error(
          "Self-repair requires protected Recovery Baseline code with the fresh candidate state snapshot.",
        );
      }
      await effects.verifyCandidate(input.candidate, actorIdentity);
      const recoveryBaselineHealth = await effects.verifyRecoveryBaseline(
        input.baseline ?? installation.active,
      );
      if (recoveryBaselineHealth.verdict !== "healthy") {
        throw new Error(
          `Recovery Baseline compatibility is ${recoveryBaselineHealth.verdict}; cutover was refused.`,
        );
      }
      const barrier = await effects.assessBarrier();
      if (!barrier.ready || barrier.blockers.length > 0) {
        throw new Error(`Activation barrier is blocked: ${barrier.blockers.join("; ") || "unknown blocker"}.`);
      }

      let attempt: ActivationAttempt = {
        ...input,
        id: randomUUID(),
        actor: actorIdentity,
        baseline: input.baseline ?? installation.active,
        writeGeneration: installation.writeGeneration,
        phase: "authorized",
      };
      recordNewAttempt(attempt);
      attempt = transition(attempt, "snapshot-pending");
      await effects.snapshotState(attempt.baseline, attempt.id);
      attempt = transition(attempt, "snapshot-complete");
      attempt = transition(attempt, "generation-transfer-pending");
      const candidateGeneration = await effects.transferWriteGeneration(attempt.writeGeneration);
      if (candidateGeneration !== attempt.writeGeneration + 1) {
        throw new Error("Write generation transfer did not produce the exact next generation.");
      }
      attempt = transition(
        { ...attempt, writeGeneration: candidateGeneration },
        "generation-transferred",
        {},
        { writeGeneration: candidateGeneration },
      );
      let candidateProcess: { pid: number; startedAt: string; nonce: string } | undefined;
      try {
        attempt = transition(attempt, "candidate-launch-pending");
        const nonce = randomUUID();
        candidateProcess = await effects.launch(attempt.candidate, {
          attemptId: attempt.id,
          writeGeneration: candidateGeneration,
          nonce,
        });
        if (candidateProcess.nonce !== nonce) {
          throw new Error("Candidate launch handshake identity does not match.");
        }
        attempt = transition(attempt, "health-handshake", { process: candidateProcess });
        const health = await effects.assessHealth(attempt.candidate, {
          attemptId: attempt.id,
          writeGeneration: candidateGeneration,
          process: candidateProcess,
          criteria: attempt.healthCriteria,
        });
        if (health.verdict !== "healthy") {
          throw new Error(`Candidate invariant health is ${health.verdict}.`);
        }
        attempt = transition(attempt, "probation", { health });
        const probation = await effects.awaitProbation(attempt.candidate, {
          attemptId: attempt.id,
          writeGeneration: candidateGeneration,
          process: candidateProcess,
          checks: attempt.budget.probationChecks,
          deadline: attempt.budget.deadline,
        });
        if (probation.verdict !== "healthy") {
          throw new Error(`Candidate probation health is ${probation.verdict}.`);
        }
        if (Date.parse(attempt.budget.deadline) <= Date.now()) {
          throw new Error("Candidate probation exceeded its fixed activation deadline.");
        }
        attempt = transition(
          attempt,
          "activated",
          { health: probation },
          { active: attempt.candidate, writeGeneration: candidateGeneration },
        );
        await effects.terminate(candidateProcess);
        return { attemptId: attempt.id, outcome: "activated" };
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        attempt = transition(attempt, "rollback-required", { failure });
        if (candidateProcess) await effects.terminate(candidateProcess);
        attempt = transition(attempt, "rollback-restore-pending");
        const restoredGeneration = await effects.restoreBaseline(
          attempt.baseline,
          candidateGeneration,
        );
        if (restoredGeneration <= candidateGeneration) {
          throw new Error("Rollback must restore the protected pair under a fresh write generation.");
        }
        attempt = { ...attempt, writeGeneration: restoredGeneration };
        const recoveryNonce = randomUUID();
        const baselineProcess = await effects.launch(attempt.baseline, {
          attemptId: attempt.id,
          writeGeneration: restoredGeneration,
          nonce: recoveryNonce,
        });
        if (baselineProcess.nonce !== recoveryNonce) {
          throw new Error("Recovery Baseline launch handshake identity does not match.");
        }
        let baselineHealth: HealthAssessment;
        try {
          baselineHealth = await effects.assessHealth(attempt.baseline, {
            attemptId: attempt.id,
            writeGeneration: restoredGeneration,
            process: baselineProcess,
            criteria: attempt.healthCriteria,
          });
          if (baselineHealth.verdict !== "healthy") {
            throw new Error(`Recovery Baseline health is ${baselineHealth.verdict}.`);
          }
        } finally {
          await effects.terminate(baselineProcess);
        }
        attempt = transition(
          attempt,
          "rolled-back",
          { process: baselineProcess, health: baselineHealth, failure },
          { active: attempt.baseline, writeGeneration: restoredGeneration },
        );
        return { attemptId: attempt.id, outcome: "rolled-back" };
      }
    },

    async recover() {
      const installation = requireInstallation(readInstallation());
      const attempt = installation.currentAttemptId
        ? readAttempt(installation.currentAttemptId)
        : undefined;
      if (!attempt || ["activated", "rolled-back"].includes(attempt.phase)) {
        return {
          ...(attempt ? { attemptId: attempt.id } : {}),
          outcome: "unchanged",
        };
      }
      const observedGeneration = await effects.currentWriteGeneration();
      const beforeTransfer = ["authorized", "snapshot-pending", "snapshot-complete"].includes(
        attempt.phase,
      );
      if (beforeTransfer) {
        if (observedGeneration !== attempt.writeGeneration) {
          throw new Error("Recovery cannot prove the pre-cutover write generation.");
        }
        transition(
          attempt,
          "rolled-back",
          { failure: "Recovery Actor restarted before generation transfer; active pair was unchanged." },
          { active: attempt.baseline, writeGeneration: observedGeneration },
        );
        return { attemptId: attempt.id, outcome: "rolled-back" };
      }

      let recoveringAttempt = attempt;
      let restoreAlreadyCompleted = false;
      if (attempt.phase === "generation-transfer-pending") {
        if (observedGeneration === attempt.writeGeneration) {
          transition(
            attempt,
            "rolled-back",
            { failure: "Recovery Actor restarted before generation transfer; active pair was unchanged." },
            { active: attempt.baseline, writeGeneration: observedGeneration },
          );
          return { attemptId: attempt.id, outcome: "rolled-back" };
        }
        if (observedGeneration !== attempt.writeGeneration + 1) {
          throw new Error("Recovery cannot reconcile the intended write generation transfer.");
        }
        recoveringAttempt = { ...attempt, writeGeneration: observedGeneration };
      } else if (observedGeneration !== attempt.writeGeneration) {
        if (
          attempt.phase === "rollback-restore-pending" &&
          observedGeneration > attempt.writeGeneration &&
          await effects.restoredBaselineGeneration(attempt.baseline, attempt.writeGeneration) ===
            observedGeneration
        ) {
          recoveringAttempt = { ...attempt, writeGeneration: observedGeneration };
          restoreAlreadyCompleted = true;
        } else {
          throw new Error("Recovery cannot prove the current Activation Attempt write generation.");
        }
      }

      const failure = recoveringAttempt.failure ??
        "Recovery Actor restarted after generation transfer; candidate continuity is not replayable.";
      if (recoveringAttempt.phase !== "rollback-required" && recoveringAttempt.phase !== "rollback-restore-pending") {
        recoveringAttempt = transition(recoveringAttempt, "rollback-required", { failure }, {
          writeGeneration: observedGeneration,
        });
      }
      if (recoveringAttempt.process) await effects.terminate(recoveringAttempt.process);
      if (!restoreAlreadyCompleted) {
        recoveringAttempt = transition(recoveringAttempt, "rollback-restore-pending", { failure });
      }
      const restoredGeneration = restoreAlreadyCompleted
        ? observedGeneration
        : await effects.restoreBaseline(recoveringAttempt.baseline, observedGeneration);
      if (!restoreAlreadyCompleted && restoredGeneration <= observedGeneration) {
        throw new Error("Recovered rollback did not establish a fresh write generation.");
      }
      recoveringAttempt = { ...recoveringAttempt, writeGeneration: restoredGeneration };
      const nonce = randomUUID();
      const baselineProcess = await effects.launch(recoveringAttempt.baseline, {
        attemptId: recoveringAttempt.id,
        writeGeneration: restoredGeneration,
        nonce,
      });
      if (baselineProcess.nonce !== nonce) {
        throw new Error("Recovered baseline launch handshake identity does not match.");
      }
      let health: HealthAssessment;
      try {
        health = await effects.assessHealth(recoveringAttempt.baseline, {
          attemptId: recoveringAttempt.id,
          writeGeneration: restoredGeneration,
          process: baselineProcess,
          criteria: recoveringAttempt.healthCriteria,
        });
        if (health.verdict !== "healthy") {
          throw new Error(`Recovered baseline health is ${health.verdict}.`);
        }
      } finally {
        await effects.terminate(baselineProcess);
      }
      transition(
        recoveringAttempt,
        "rolled-back",
        { process: baselineProcess, health, failure },
        { active: recoveringAttempt.baseline, writeGeneration: restoredGeneration },
      );
      return { attemptId: recoveringAttempt.id, outcome: "rolled-back" };
    },

    resetLeadRestartBudget(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error("Lead Agent restart budget must be a positive integer.");
      }
      const installation = requireInstallation(readInstallation());
      database
        .prepare("UPDATE installation SET value_json = ? WHERE singleton = 1")
        .run(JSON.stringify({
          ...installation,
          leadRestartBudget: {
            revision: installation.active.code.revision,
            limit,
            remaining: limit,
            failures: [],
          },
        } satisfies Installation));
    },

    recordLeadFailure(revision, detail) {
      const installation = requireInstallation(readInstallation());
      if (revision !== installation.active.code.revision) {
        throw new Error("Lead Agent failure revision does not match the accepted active revision.");
      }
      if (!detail.trim()) throw new Error("Lead Agent failure detail is required.");
      const budget = installation.leadRestartBudget;
      if (budget.revision !== revision) {
        throw new Error("Lead Agent restart budget is attributed to a different revision.");
      }
      const remaining = Math.max(0, budget.remaining - 1);
      const updated: Installation = {
        ...installation,
        leadRestartBudget: {
          ...budget,
          remaining,
          failures: [
            ...budget.failures,
            { observedAt: new Date().toISOString(), detail },
          ],
        },
      };
      database
        .prepare("UPDATE installation SET value_json = ? WHERE singleton = 1")
        .run(JSON.stringify(updated));
      return { remaining, exhausted: remaining === 0 };
    },

    inspect() {
      const installation = readInstallation();
      if (!installation) return {};
      return {
        actor: installation.actor,
        active: installation.active,
        recoveryBaseline: installation.recoveryBaseline,
        writeGeneration: installation.writeGeneration,
        leadRestartBudget: installation.leadRestartBudget,
        ...(installation.currentAttemptId
          ? { currentAttempt: readAttempt(installation.currentAttemptId) }
          : {}),
      };
    },

    inspectSelfRepairAttempt(selfRepairId, selfRepairAttemptId) {
      const row = database
        .prepare(`
          SELECT value_json
            FROM activation_attempts
           WHERE json_extract(value_json, '$.authority.kind') = 'lead-agent-self-repair'
             AND json_extract(value_json, '$.authority.selfRepairId') = ?
             AND json_extract(value_json, '$.authority.selfRepairAttemptId') = ?
           ORDER BY updated_at DESC
           LIMIT 1
        `)
        .get(selfRepairId, selfRepairAttemptId) as { value_json: string } | undefined;
      return row ? JSON.parse(row.value_json) as ActivationAttempt : undefined;
    },

    close() {
      database.close();
    },
  };
}

function ensureSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS installation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      value_json TEXT NOT NULL CHECK (json_valid(value_json))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS activation_attempts (
      id TEXT PRIMARY KEY,
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS activation_transitions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL REFERENCES activation_attempts(id),
      phase TEXT NOT NULL,
      value_json TEXT NOT NULL CHECK (json_valid(value_json)),
      recorded_at TEXT NOT NULL
    ) STRICT;
  `);
}

function requireInstallation(installation: Installation | undefined): Installation {
  if (!installation) throw new Error("Recovery Actor is not initialized.");
  return installation;
}

function validateActivationInput(
  input: Omit<ActivationAttempt, "id" | "actor" | "baseline" | "writeGeneration" | "phase" | "process" | "health" | "failure"> & {
    baseline?: CodeStatePair;
  },
  actor: RecoveryActorIdentity,
): void {
  validatePair(input.candidate);
  if (input.baseline) validatePair(input.baseline);
  if (pathsOverlap(input.candidate.code.path, actor.path)) {
    throw new Error("A Lead Agent candidate cannot replace the protected Recovery Actor.");
  }
  if (
    input.authority.kind === "lead-agent-self-repair" &&
    (!input.authority.selfRepairId.trim() ||
      !input.authority.selfRepairAttemptId.trim() ||
      !input.authority.commitmentId.trim() ||
      input.authority.recoveryActorRevision !== actor.revision ||
      input.authority.recoveryActorDigest !== actor.digest ||
      !samePath(input.authority.recoveryActorPath, actor.path) ||
      input.authority.recoveryPolicyRevision !== protectedRecoveryPolicyIdentity.revision ||
      input.authority.recoveryPolicyDigest !== protectedRecoveryPolicyIdentity.digest)
  ) {
    throw new Error("Self-repair activation requires exact repair, Recovery Actor, and protected policy identity.");
  }
  const criteria = new Set(input.healthCriteria);
  if (
    criteria.size !== requiredActivationHealthCriteria.length ||
    requiredActivationHealthCriteria.some((criterion) => !criteria.has(criterion)) ||
    !Number.isSafeInteger(input.budget.probationChecks) ||
    input.budget.probationChecks < 1 ||
    !Number.isFinite(Date.parse(input.budget.deadline)) ||
    Date.parse(input.budget.deadline) <= Date.now()
  ) {
    throw new Error("Activation requires fixed health criteria and a bounded probation budget.");
  }
}

function validateActor(actor: RecoveryActorIdentity): void {
  if (!actor.revision.trim() || !isDigest(actor.digest) || !actor.path.trim()) {
    throw new Error("Recovery Actor identity must include exact revision, digest, and path.");
  }
}

function validatePair(pair: CodeStatePair): void {
  if (
    !pair.code.revision.trim() ||
    !isDigest(pair.code.digest) ||
    !pair.code.path.trim() ||
    !pair.code.runtime.version.trim() ||
    !pair.state.revision.trim() ||
    !isDigest(pair.state.digest) ||
    !pair.state.snapshotPath.trim()
  ) {
    throw new Error("A code-and-state pair requires exact immutable identities.");
  }
}

function isDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function sameActor(left: RecoveryActorIdentity, right: RecoveryActorIdentity): boolean {
  return left.revision === right.revision && left.digest === right.digest && samePath(left.path, right.path);
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function pathsOverlap(left: string, right: string): boolean {
  return samePath(left, right) || isWithin(left, right) || isWithin(right, left);
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

function sameCode(left: CodeStatePair["code"], right: CodeStatePair["code"]): boolean {
  return left.revision === right.revision &&
    left.digest === right.digest &&
    samePath(left.path, right.path) &&
    JSON.stringify(left.runtime) === JSON.stringify(right.runtime);
}
