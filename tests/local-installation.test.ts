import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createLocalInstallation,
  localInstallationPaths,
  readGeneration,
  type CodeStatePair,
  type LocalInstallation,
} from "../src/local-installation/index.ts";
import type { LocalLeadHostClient } from "../src/local-host/index.ts";
import type { LocalReleaseManifest } from "../src/local-release/index.ts";

const bundlePayload = {
  "dist/cli.js": Buffer.from("console.log('lead');\n"),
  "dist/lifecycle-cli.js": Buffer.from("console.log('lifecycle');\n"),
  "dist/owner-launcher.js": Buffer.from("console.log('launcher');\n"),
  "dist/owner-client.js": Buffer.from("console.log('client');\n"),
  "dist/owner-gateway-cli.js": Buffer.from("console.log('gateway');\n"),
  "runtime/node.exe": Buffer.from("fake pinned node runtime"),
};

type Harness = {
  installation: LocalInstallation;
  root: string;
  spawns: CodeStatePair[];
  hostRunning: { value: boolean };
};

async function harness(t: { after(callback: () => void | Promise<void>): void }): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-lifecycle-v2-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spawns: CodeStatePair[] = [];
  const hostRunning = { value: false };
  const installation = createLocalInstallation({
    installationRoot: root,
    spawnHost: async (active) => {
      spawns.push(active);
      hostRunning.value = true;
    },
    probeHost: async () => hostRunning.value,
    connectHost: async () => fakeClient(hostRunning),
  });
  return { installation, root, spawns, hostRunning };
}

function fakeClient(hostRunning: { value: boolean }): LocalLeadHostClient {
  return {
    address: "fake",
    childPid: 1,
    transcript: [],
    exit: new Promise(() => {}),
    async sendOwnerLine() {},
    async stop() {
      hostRunning.value = false;
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

async function writeCandidate(
  parent: string,
  revision: string,
  marker = "lead",
): Promise<string> {
  const directory = join(parent, `candidate-${revision}`);
  const files = {
    ...bundlePayload,
    "dist/cli.js": Buffer.from(`console.log('${marker}');\n`),
  };
  const manifest: LocalReleaseManifest = {
    formatVersion: 1,
    kind: "lead-agent",
    revision,
    entrypoint: "dist/cli.js",
    runtime: { version: "24.17.0", architecture: "x64", path: "runtime/node.exe" },
    files: Object.entries(files).map(([path, bytes]) => ({
      path,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  await mkdir(directory, { recursive: true });
  for (const [path, bytes] of Object.entries(files)) {
    const destination = join(directory, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  return directory;
}

async function installed(t: Parameters<typeof harness>[0]): Promise<Harness> {
  const context = await harness(t);
  const candidate = await writeCandidate(context.root, "rev-1");
  await context.installation.initialInstall({
    leadAgentCandidateDirectory: candidate,
    stateRevision: "initial-state",
    stateProvenance: "test install",
  });
  return context;
}

test("install stages the bundle, snapshots initial state, and writes the v2 launcher", async (t) => {
  const { installation, root } = await harness(t);
  const candidate = await writeCandidate(root, "rev-1");
  const result = await installation.initialInstall({
    leadAgentCandidateDirectory: candidate,
    stateRevision: "initial-state",
    stateProvenance: "test install",
  });

  assert.equal(result.status, "installed");
  assert.equal(result.active?.code.revision, "rev-1");
  assert.equal(result.active?.state.revision, "initial-state");
  const paths = localInstallationPaths(root);
  assert.ok(existsSync(join(paths.leadAgentVersions, "rev-1", "manifest.json")));
  assert.ok(existsSync(result.active!.state.snapshotPath));
  assert.equal(readGeneration(paths.state), 1);

  const manifest = JSON.parse(
    await readFile(join(paths.launcher, "installation.json"), "utf8"),
  ) as {
    formatVersion: number;
    leadAgent: { lifecyclePath: string; runtimePath: string; ownerGatewayPath: string };
  };
  assert.equal(manifest.formatVersion, 2);
  assert.ok(manifest.leadAgent.lifecyclePath.endsWith("lifecycle-cli.js"));
  assert.ok(manifest.leadAgent.ownerGatewayPath.endsWith("owner-gateway-cli.js"));
  const riker = await readFile(join(paths.launcher, "riker.cmd"), "utf8");
  assert.match(riker, /owner-launcher\.js/);

  await assert.rejects(
    installation.initialInstall({
      leadAgentCandidateDirectory: candidate,
      stateRevision: "initial-state",
      stateProvenance: "test install",
    }),
    /already installed/,
  );
});

test("start spawns the detached host once and reuses a live host", async (t) => {
  const context = await installed(t);
  const first = await context.installation.start();
  await first.detach();
  assert.equal(context.spawns.length, 1);

  const second = await context.installation.start();
  await second.detach();
  assert.equal(context.spawns.length, 1, "a live host is reused, not respawned");

  const inspection = await context.installation.inspect();
  assert.equal(inspection.hostRunning, true);
  assert.equal(inspection.stopRequested, false);
});

test("stop records the durable stop intent even when no host is reachable", async (t) => {
  const context = await installed(t);
  await context.installation.stop();
  const inspection = await context.installation.inspect();
  assert.equal(inspection.stopRequested, true);
  assert.equal(inspection.hostRunning, false);

  await context.installation.start();
  assert.equal((await context.installation.inspect()).stopRequested, false);
});

test("upgrade snapshots state, fences the old generation, and records the previous pair", async (t) => {
  const context = await installed(t);
  await context.installation.start();
  const paths = localInstallationPaths(context.root);
  const generationBefore = readGeneration(paths.state);

  const candidate = await writeCandidate(context.root, "rev-2", "lead-2");
  const result = await context.installation.upgrade({
    leadAgentCandidateDirectory: candidate,
    stateRevision: "before-rev-2",
    stateProvenance: "test upgrade",
  });

  assert.equal(result.outcome, "activated");
  assert.equal(result.active.code.revision, "rev-2");
  assert.equal(result.previous.code.revision, "rev-1");
  assert.equal(result.snapshot.revision, "before-rev-2");
  assert.ok(existsSync(result.snapshot.path));
  assert.equal(readGeneration(paths.state), generationBefore + 1, "old hosts are fenced");
  assert.equal(context.hostRunning.value, false, "the old host was stopped");

  const inspection = await context.installation.inspect();
  assert.equal(inspection.active?.code.revision, "rev-2");
  assert.equal(inspection.previous?.code.revision, "rev-1");
});

test("rollback restores the previous pair and state with a fresh generation", async (t) => {
  const context = await installed(t);
  const paths = localInstallationPaths(context.root);

  // Put a marker into state, upgrade (which snapshots it), then mutate state again.
  const stateDb = () => new DatabaseSync(join(paths.state, "authoritative-state.sqlite"));
  let database = stateDb();
  database.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('before-upgrade');");
  database.close();

  const candidate = await writeCandidate(context.root, "rev-2", "lead-2");
  await context.installation.upgrade({
    leadAgentCandidateDirectory: candidate,
    stateRevision: "before-rev-2",
    stateProvenance: "test upgrade",
  });
  database = stateDb();
  database.exec("UPDATE marker SET value = 'after-upgrade'");
  database.close();
  const generationBefore = readGeneration(paths.state);

  const result = await context.installation.rollback();
  assert.equal(result.outcome, "rolled-back");
  assert.equal(result.active.code.revision, "rev-1");
  assert.ok(result.restoredWriteGeneration > generationBefore);

  database = stateDb();
  const marker = database.prepare("SELECT value FROM marker").get() as { value: string };
  database.close();
  assert.equal(marker.value, "before-upgrade", "state returned to the pre-upgrade snapshot");
  assert.equal((await context.installation.inspect()).active?.code.revision, "rev-1");
  assert.equal((await context.installation.inspect()).previous?.code.revision, "rev-2");
});

test("nextRevision counts a numeric tail and seeds one when missing", async () => {
  const { nextRevision } = await import("../src/local-installation/index.ts");
  assert.equal(nextRevision("local.25"), "local.26");
  assert.equal(nextRevision("riker-0.1.0-local.9"), "riker-0.1.0-local.10");
  assert.equal(nextRevision("release-99"), "release-100");
  assert.equal(nextRevision("nightly"), "nightly.2");
  assert.equal(nextRevision("nightly.2"), "nightly.3");
});

test("rollback without a previous version is refused", async (t) => {
  const context = await installed(t);
  await assert.rejects(context.installation.rollback(), /No previous version/);
});

test("a durable lifecycle operation serializes upgrade against other operations", async (t) => {
  const context = await installed(t);
  const paths = localInstallationPaths(context.root);
  const journal = new DatabaseSync(paths.lifecycleJournal);
  const row = journal
    .prepare("SELECT active_json FROM local_lifecycle_v2 WHERE singleton = 1")
    .get() as { active_json: string };
  journal
    .prepare("UPDATE local_lifecycle_v2 SET operation_json = ? WHERE singleton = 1")
    .run(JSON.stringify({
      id: "held",
      kind: "upgrade",
      pid: process.pid,
      startedAt: await currentProcessStartedAt(),
    }));
  journal.close();
  assert.ok(JSON.parse(row.active_json));

  await assert.rejects(context.installation.stop(), /already in progress/);

  // An operation held by a dead process is reclaimed instead of blocking forever.
  const stale = new DatabaseSync(paths.lifecycleJournal);
  stale
    .prepare("UPDATE local_lifecycle_v2 SET operation_json = ? WHERE singleton = 1")
    .run(JSON.stringify({
      id: "stale",
      kind: "upgrade",
      pid: 4_000_000,
      startedAt: "2000-01-01T00:00:00.000Z",
    }));
  stale.close();
  await context.installation.stop();
  assert.equal((await context.installation.inspect()).stopRequested, true);
});

test("uninstall removes launch material and preserves state and recovery", async (t) => {
  const context = await installed(t);
  const paths = localInstallationPaths(context.root);
  await context.installation.uninstall();

  assert.equal(existsSync(paths.leadAgentVersions), false);
  assert.equal(existsSync(paths.launcher), false);
  assert.ok(existsSync(join(paths.state, "authoritative-state.sqlite")));
  assert.ok(existsSync(paths.snapshots));
  const inspection = await context.installation.inspect();
  assert.equal(inspection.status, "uninstalled");

  const candidate = await writeCandidate(context.root, "rev-3");
  const reinstalled = await context.installation.initialInstall({
    leadAgentCandidateDirectory: candidate,
    stateRevision: "reinstall-state",
    stateProvenance: "test reinstall",
  });
  assert.equal(reinstalled.status, "installed");
  assert.equal(reinstalled.active?.code.revision, "rev-3");
});

async function currentProcessStartedAt(): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
    ],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}
