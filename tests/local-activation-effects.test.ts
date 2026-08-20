import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { createLocalActivationEffects } from "../src/local-activation-effects.ts";
import { verifyLocalReleaseCandidate } from "../src/local-release/index.ts";
import { createAuthoritativeStateSnapshot } from "../src/state-snapshot/index.ts";

test("production activation effects supervise one live candidate through external health and probation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-production-activation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, "state");
  const recoveryDirectory = join(root, "recovery");
  const candidateDirectory = join(root, "candidate");
  await mkdir(stateDirectory);
  const state = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });
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
  const snapshot = await createAuthoritativeStateSnapshot({
    stateDirectory,
    recoveryDirectory,
    revision: "before-candidate",
    provenance: "production activation effect test",
  });
  await writeCandidate(candidateDirectory);
  const release = await verifyLocalReleaseCandidate(candidateDirectory, "lead-agent");
  const pair = {
    code: {
      revision: release.identity.revision,
      digest: release.identity.digest,
      path: release.path,
      runtime: {
        version: release.runtime.version,
        architecture: release.runtime.architecture,
      },
    },
    state: {
      revision: snapshot.revision,
      digest: snapshot.digest,
      snapshotPath: snapshot.path,
    },
  };
  const effects = createLocalActivationEffects({
    installationRoot: root,
    stateDirectory,
    recoveryDirectory,
  });
  await effects.verifyCandidate(pair, {
    revision: "actor-1",
    digest: "f".repeat(64),
    path: join(root, "protected-actor"),
  });
  assert.equal((await effects.verifyRecoveryBaseline(pair)).verdict, "healthy");
  assert.deepEqual(await effects.assessBarrier(), { ready: true, blockers: [] });
  assert.equal(await effects.transferWriteGeneration(1), 2);

  const process = await effects.launch(pair, {
    attemptId: "attempt-production-1",
    writeGeneration: 2,
    nonce: "nonce-production-1",
  });
  const health = await effects.assessHealth(pair, {
    attemptId: "attempt-production-1",
    writeGeneration: 2,
    process,
    criteria: [],
  });
  assert.equal(health.verdict, "healthy");
  const probation = await effects.awaitProbation(pair, {
    attemptId: "attempt-production-1",
    writeGeneration: 2,
    process,
    checks: 2,
    deadline: new Date(Date.now() + 5_000).toISOString(),
  });
  assert.equal(probation.verdict, "healthy");
  await effects.terminate(process);
});

async function writeCandidate(directory: string): Promise<void> {
  const entrypoint = new URL("./support/provisional-lead.ts", import.meta.url)
    .pathname.replace(/^\/(.:)/, "$1");
  const files = {
    "dist/provisional-lead.ts": await readFile(entrypoint),
    "runtime/node.exe": await readFile(process.execPath),
  };
  for (const [path, bytes] of Object.entries(files)) {
    const destination = join(directory, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    if (path === "runtime/node.exe") await copyFile(process.execPath, destination);
    else await writeFile(destination, bytes);
  }
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    kind: "lead-agent",
    revision: "candidate-production-1",
    entrypoint: "dist/provisional-lead.ts",
    runtime: { version: "24.17.0", architecture: process.arch, path: "runtime/node.exe" },
    files: Object.entries(files).map(([path, bytes]) => ({
      path,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  }));
}
