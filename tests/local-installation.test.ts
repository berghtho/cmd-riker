import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createLocalInstallation,
  LocalInstallationError,
  type LocalInstallationSupervision,
} from "../src/local-installation/index.ts";
import type {
  LocalReleaseKind,
  LocalReleaseManifest,
} from "../src/local-release/index.ts";
import type { LocalLeadHostClient } from "../src/local-host/index.ts";
import type {
  ActivationEffects,
  CodeStatePair,
  HealthAssessment,
} from "../src/recovery-actor/index.ts";
import { advanceWriteGeneration } from "../src/write-generation.ts";

const bundlePayload = {
  "dist/main.js": Buffer.from("console.log('local installation');\n"),
  "runtime/node.exe": Buffer.from("bundled Node runtime"),
};

test("happy install stages exact protected identities before register and verifies the per-user task", async (t) => {
  const fixture = await installationFixture(t);

  const installed = await fixture.installation.initialInstall(fixture.initialInput);

  assert.equal(installed.status, "installed");
  assert.equal(installed.stopRequested, false);
  assert.equal(installed.stopped, true);
  assert.equal(installed.actor?.revision, "actor-1");
  assert.equal(installed.active?.code.revision, "lead-1");
  assert.equal(installed.active?.state.revision, "state-1");
  assert.equal(installed.writeGeneration, 1);
  assert.equal(fixture.supervision.events.join(","), "register,verify,inspect");
  assert(installed.actor?.path.startsWith(installed.paths.protectedRecoveryActorVersions));
  assert(installed.active?.code.path.startsWith(installed.paths.leadAgentVersions));
  assert(!installed.actor?.path.startsWith(installed.paths.leadAgentVersions));
  await access(join(installed.actor!.path, "runtime", "node.exe"));
  await access(join(installed.active!.code.path, "runtime", "node.exe"));
  await access(installed.paths.activationJournal);
  await access(installed.paths.lifecycleJournal);
  const launcher = JSON.parse(
    await readFile(join(installed.paths.launcher, "installation.json"), "utf8"),
  ) as { actor: { identity: { digest: string } }; leadAgent: { identity: { digest: string } } };
  assert.equal(launcher.actor.identity.digest, installed.actor?.digest);
  assert.equal(launcher.leadAgent.identity.digest, installed.active?.code.digest);
  assert.match(
    await readFile(join(installed.paths.launcher, "riker.cmd"), "utf8"),
    /main\.js" %\*/,
  );
});

test("duplicate start delegates singleton launch and reconnects to the same local host", async (t) => {
  const connections: string[] = [];
  const fixture = await installationFixture(t, {
    connectHost: async (address) => {
      connections.push(address);
      return hostClient(connections.length, address);
    },
  });
  await fixture.installation.initialInstall(fixture.initialInput);

  const first = await fixture.installation.start();
  const second = await fixture.installation.start();

  assert.equal(first.address, second.address);
  assert.deepEqual(connections, [first.address, first.address]);
  assert.equal(fixture.supervision.events.filter((event) => event === "start").length, 2);
  assert.equal((await fixture.installation.inspect()).stopRequested, false);
});

test("a durable lifecycle operation serializes start against upgrade and uninstall", async (t) => {
  const connecting = Promise.withResolvers<void>();
  const releaseConnection = Promise.withResolvers<void>();
  const fixture = await installationFixture(t, {
    connectHost: async (address) => {
      connecting.resolve();
      await releaseConnection.promise;
      return hostClient(1, address);
    },
  });
  await fixture.installation.initialInstall(fixture.initialInput);

  const starting = fixture.installation.start();
  await connecting.promise;
  await assert.rejects(
    fixture.installation.uninstall(),
    (error: unknown) => {
      assert(error instanceof LocalInstallationError);
      const messages: string[] = [];
      let current: unknown = error;
      while (current instanceof Error) {
        messages.push(current.message);
        current = current.cause;
      }
      assert.match(messages.join("\n"), /operation start is already in progress/);
      return true;
    },
  );
  assert.equal((await fixture.installation.inspect()).currentOperation?.kind, "start");

  releaseConnection.resolve();
  await starting;
  assert.equal((await fixture.installation.inspect()).currentOperation, undefined);
});

test("manual start reclaims an abandoned upgrade operation and lets the protected actor recover", async (t) => {
  const fixture = await installationFixture(t);
  const installed = await fixture.installation.initialInstall(fixture.initialInput);
  const database = new DatabaseSync(installed.paths.lifecycleJournal);
  database
    .prepare("UPDATE local_installation SET operation_json = ? WHERE singleton = 1")
    .run(JSON.stringify({
      id: "abandoned-upgrade",
      kind: "upgrade",
      pid: 2_000_000_000,
      startedAt: "2026-08-20T12:00:00.000Z",
    }));
  database.close();

  const client = await fixture.installation.start();

  assert.equal(client.childPid, 1);
  assert.equal((await fixture.installation.inspect()).currentOperation, undefined);
});

test("stop intent remains durable when the Lead host cannot be contacted", async (t) => {
  const fixture = await installationFixture(t, {
    requestStop: async () => {
      throw new Error("pipe unavailable");
    },
  });
  await fixture.installation.initialInstall(fixture.initialInput);
  await fixture.installation.start();

  await fixture.installation.stop();

  const inspection = await fixture.installation.inspect();
  assert.equal(inspection.stopRequested, true);
  assert.equal(inspection.stopped, true);
  assert.equal(fixture.supervision.events.includes("stop"), true);
});

test("registration verification rollback unregisters the task but preserves state and recovery", async (t) => {
  const fixture = await installationFixture(t);
  fixture.supervision.verifyError = new Error("configured task drifted");

  await assert.rejects(
    fixture.installation.initialInstall(fixture.initialInput),
    (error: unknown) => {
      assert(error instanceof LocalInstallationError);
      assert.equal(error.operation, "install");
      assert.equal(
        error.message,
        "Local installation scheduler registration failed and was rolled back.",
      );
      return true;
    },
  );

  assert.deepEqual(fixture.supervision.events, ["register", "verify", "unregister"]);
  assert.equal(fixture.supervision.registered, false);
  const inspection = await fixture.installation.inspect();
  assert.equal(inspection.status, "registration-failed");
  await access(join(inspection.paths.state, "authoritative-state.sqlite"));
  await access(inspection.paths.activationJournal);
  await access(inspection.active!.state.snapshotPath);
});

test("Owner upgrade snapshots SQLite state before handing the exact candidate pair to activation", async (t) => {
  let verifiedCandidate: CodeStatePair | undefined;
  const fixture = await installationFixture(t, {
    effectsHooks: {
      verifyCandidate(candidate) {
        verifiedCandidate = candidate;
      },
    },
  });
  await fixture.installation.initialInstall(fixture.initialInput);
  const lead2 = join(fixture.root, "candidate-lead-2");
  await writeBundle(lead2, "lead-agent", "lead-2");

  const result = await fixture.installation.upgrade({
    leadAgentCandidateDirectory: lead2,
    stateRevision: "state-for-lead-2",
    stateProvenance: "owner-upgrade-lead-2",
    activation: activationRequest(),
  });

  assert.equal(result.outcome, "activated");
  assert.deepEqual(verifiedCandidate, result.candidate);
  assert.deepEqual(result.candidate.state, {
    revision: result.snapshot.revision,
    digest: result.snapshot.digest,
    snapshotPath: result.snapshot.path,
  });
  assert.equal(result.snapshot.writeGeneration, 1);
  const snapshotDatabase = new DatabaseSync(result.snapshot.path, { readOnly: true });
  assert.equal(
    (snapshotDatabase.prepare("PRAGMA integrity_check").get() as { integrity_check: string })
      .integrity_check,
    "ok",
  );
  snapshotDatabase.close();
  const inspection = await fixture.installation.inspect();
  assert.deepEqual(inspection.active, result.candidate);
  assert.equal(inspection.currentAttempt?.candidate.state.digest, result.snapshot.digest);
  assert.equal(inspection.currentAttempt?.baseline.state.digest, result.snapshot.digest);
  assert.equal(inspection.currentAttempt?.baseline.code.revision, "lead-1");
});

test("upgrade restarts protected supervision before transferring Authoritative State", async (t) => {
  const events: string[] = [];
  const fixture = await installationFixture(t, {
    supervisionEvents: events,
    effectsHooks: {
      beforeGenerationTransfer() {
        assert.equal(events.includes("start"), true);
      },
    },
  });
  await fixture.installation.initialInstall(fixture.initialInput);
  const lead2 = join(fixture.root, "candidate-lead-supervised");
  await writeBundle(lead2, "lead-agent", "lead-supervised");
  events.length = 0;

  await fixture.installation.upgrade({
    leadAgentCandidateDirectory: lead2,
    stateRevision: "state-supervised",
    stateProvenance: "supervised-upgrade",
    activation: activationRequest(),
  });

  assert.equal(events[0], "start");
  assert.equal((await fixture.installation.inspect()).stopped, false);
});

test("invalid upgrade preparation leaves the accepted Lead Agent running", async (t) => {
  const events: string[] = [];
  const fixture = await installationFixture(t, { supervisionEvents: events });
  await fixture.installation.initialInstall(fixture.initialInput);
  await fixture.installation.start();
  const invalid = join(fixture.root, "invalid-candidate");
  await writeBundle(invalid, "lead-agent", "invalid-lead");
  await writeFile(join(invalid, "dist", "main.js"), "tampered after manifest");
  events.length = 0;

  await assert.rejects(
    fixture.installation.upgrade({
      leadAgentCandidateDirectory: invalid,
      stateRevision: "invalid-preparation",
      stateProvenance: "must not cut over",
      activation: activationRequest(),
    }),
    /upgrade failed/,
  );

  assert.equal(events.includes("stop"), false);
  assert.equal((await fixture.installation.inspect()).stopped, false);
});

test("uninstall safely stops and removes launch material while preserving all durable evidence", async (t) => {
  const order: string[] = [];
  const fixture = await installationFixture(t, {
    supervisionEvents: order,
    requestStop: async () => {
      order.push("record-stop-intent");
    },
  });
  const installed = await fixture.installation.initialInstall(fixture.initialInput);
  await fixture.installation.start();
  order.length = 0;
  const failedEvidence = join(installed.paths.failedEvidence, "failed.sqlite");
  await writeFile(failedEvidence, "failed generation evidence");
  const stateBefore = await readFile(join(installed.paths.state, "authoritative-state.sqlite"));
  const journalBefore = await readFile(installed.paths.activationJournal);

  await fixture.installation.uninstall();

  assert.deepEqual(order, ["record-stop-intent", "stop", "unregister"]);
  await assert.rejects(access(installed.paths.leadAgentVersions), { code: "ENOENT" });
  await assert.rejects(access(join(installed.paths.root, "protected")), { code: "ENOENT" });
  await assert.rejects(access(installed.paths.launcher), { code: "ENOENT" });
  assert.deepEqual(
    await readFile(join(installed.paths.state, "authoritative-state.sqlite")),
    stateBefore,
  );
  assert.deepEqual(await readFile(installed.paths.activationJournal), journalBefore);
  assert.equal(await readFile(failedEvidence, "utf8"), "failed generation evidence");
  await access(installed.active!.state.snapshotPath);
  const inspection = await fixture.installation.inspect();
  assert.equal(inspection.status, "uninstalled");
  assert.equal(inspection.stopRequested, true);
  assert.equal(inspection.stopped, true);
});

class FakeSupervision implements LocalInstallationSupervision {
  readonly events: string[];
  registered = false;
  verifyError?: Error;

  constructor(events: string[] = []) {
    this.events = events;
  }

  async register(): Promise<void> {
    this.events.push("register");
    this.registered = true;
  }

  async verify() {
    this.events.push("verify");
    if (this.verifyError) throw this.verifyError;
    return supervisionInspection();
  }

  async inspect() {
    this.events.push("inspect");
    return supervisionInspection();
  }

  async start(): Promise<void> {
    this.events.push("start");
  }

  async stop(): Promise<void> {
    this.events.push("stop");
  }

  async unregister(): Promise<void> {
    this.events.push("unregister");
    this.registered = false;
  }
}

async function installationFixture(
  t: test.TestContext,
  overrides: {
    connectHost?: (address: string) => Promise<LocalLeadHostClient>;
    requestStop?: (address: string) => Promise<void>;
    supervisionEvents?: string[];
    effectsHooks?: {
      verifyCandidate?: (candidate: CodeStatePair) => void;
      beforeGenerationTransfer?: () => void;
    };
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-installation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actor = join(root, "candidate-actor-1");
  const lead = join(root, "candidate-lead-1");
  await writeBundle(actor, "recovery-actor", "actor-1");
  await writeBundle(lead, "lead-agent", "lead-1");
  const supervision = new FakeSupervision(overrides.supervisionEvents);
  const installation = createLocalInstallation({
    installationRoot: join(root, "installed"),
    supervision,
    activationEffects: activationEffects(join(root, "installed", "state"), overrides.effectsHooks),
    connectHost: overrides.connectHost ?? (async (address) => hostClient(1, address)),
    ...(overrides.requestStop ? { requestStop: overrides.requestStop } : {}),
  });
  return {
    root,
    supervision,
    installation,
    initialInput: {
      recoveryActorCandidateDirectory: actor,
      leadAgentCandidateDirectory: lead,
      stateRevision: "state-1",
      stateProvenance: "initial-install",
    },
  };
}

function activationEffects(
  stateDirectory: string,
  hooks: {
    verifyCandidate?: (candidate: CodeStatePair) => void;
    beforeGenerationTransfer?: () => void;
  } = {},
): ActivationEffects {
  const healthy: HealthAssessment = {
    verdict: "healthy",
    subject: "candidate",
    scope: "installation-test",
    observedAt: "2026-08-20T12:01:00.000Z",
    evidence: ["fixed-health-contract"],
  };
  return {
    async verifyCandidate(candidate) {
      hooks.verifyCandidate?.(candidate);
    },
    async verifyRecoveryBaseline() {
      return healthy;
    },
    async assessBarrier() {
      return { ready: true, blockers: [] };
    },
    async snapshotState() {},
    async transferWriteGeneration(expected) {
      hooks.beforeGenerationTransfer?.();
      return advanceWriteGeneration(stateDirectory, expected);
    },
    async currentWriteGeneration() {
      const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"), {
        readOnly: true,
      });
      const row = database
        .prepare("SELECT write_generation FROM lifecycle_metadata WHERE singleton = 1")
        .get() as { write_generation: number };
      database.close();
      return row.write_generation;
    },
    async launch(_pair, context) {
      return { pid: 42, startedAt: "2026-08-20T12:00:30.000Z", nonce: context.nonce };
    },
    async assessHealth() {
      return healthy;
    },
    async awaitProbation() {
      return healthy;
    },
    async terminate() {},
    async restoreBaseline(_pair, failedGeneration) {
      return advanceWriteGeneration(stateDirectory, failedGeneration);
    },
    async restoredBaselineGeneration() {
      return undefined;
    },
  };
}

function activationRequest() {
  return {
    authority: {
      kind: "owner-supplied-upgrade" as const,
      authorizedAt: "2026-08-20T12:00:00.000Z",
    },
    compatibility: {
      stateSchema: "lossless-return-proven" as const,
      evidence: "sqlite-native-baseline",
    },
    verification: { verdict: "passed" as const, evidence: ["bundle-digest", "snapshot"] },
    review: { verdict: "passed" as const, evidence: ["owner-supplied"] },
    healthCriteria: [
      "exact-identity",
      "artifact-integrity",
      "authoritative-state",
      "write-generation",
      "conversation-context",
      "write-read-probe",
      "recovery-handshake",
    ],
    budget: { deadline: "2099-08-20T12:05:00.000Z", probationChecks: 2 },
    recoveryPath: "restore-exact-baseline-pair" as const,
  };
}

function hostClient(id: number, address = "test-host-address"): LocalLeadHostClient {
  return {
    address,
    childPid: id,
    transcript: [],
    exit: new Promise(() => {}),
    async sendOwnerLine() {},
    async stop() {
      return { kind: "explicit-stop", code: 0, signal: null };
    },
    async detach() {},
    onTranscriptEntry() {
      return () => {};
    },
    onExit() {
      return () => {};
    },
  };
}

function supervisionInspection() {
  return {
    xml: "<Task />",
    userId: "WORKSTATION\\owner",
    logonType: "InteractiveToken",
    runLevel: "LeastPrivilege",
    actionContext: "CurrentUser",
    command: "node.exe",
    arguments: "actor.js",
    actionType: "Exec",
    multipleInstancesPolicy: "IgnoreNew",
    restartCount: 4,
    restartIntervalMinutes: 2,
    allowStartOnDemand: true,
    enabled: true,
    hasTriggers: false,
    disallowStartIfOnBatteries: false,
    stopIfGoingOnBatteries: false,
    runOnlyIfIdle: false,
    stopOnIdleEnd: false,
    restartOnIdle: false,
    executionTimeLimit: "PT0S",
  };
}

async function writeBundle(
  directory: string,
  kind: LocalReleaseKind,
  revision: string,
): Promise<void> {
  const manifest: LocalReleaseManifest = {
    formatVersion: 1,
    kind,
    revision,
    entrypoint: "dist/main.js",
    runtime: { version: "24.17.0", architecture: "x64", path: "runtime/node.exe" },
    files: Object.entries(bundlePayload).map(([path, bytes]) => ({
      path,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  await mkdir(directory, { recursive: true });
  for (const [path, bytes] of Object.entries(bundlePayload)) {
    const destination = join(directory, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
}
