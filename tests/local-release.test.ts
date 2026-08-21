import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  parseLocalReleaseManifest,
  stageLocalRelease,
  verifyLocalReleaseCandidate,
  type LocalReleaseKind,
  type LocalReleaseManifest,
} from "../src/local-release/index.ts";

const payload = {
  "dist/main.js": Buffer.from("console.log('riker');\n"),
  "runtime/node.exe": Buffer.from("fake pinned node runtime"),
};

test("strictly parses format version 1 Lead Agent manifests", () => {
  const manifest = releaseManifest("lead-agent", "revision-1", payload);
  assert.deepEqual(parseLocalReleaseManifest(JSON.stringify(manifest, null, 2)), manifest);
  assert.throws(
    () => parseLocalReleaseManifest(JSON.stringify({ ...manifest, kind: "recovery-actor" })),
    /kind is invalid/,
  );

  const valid = releaseManifest("lead-agent", "revision-1", payload);
  assert.throws(
    () => parseLocalReleaseManifest(JSON.stringify({ ...valid, unexpected: true })),
    /exactly the format version 1 keys/,
  );
  const { revision: _revision, ...missingRevision } = valid;
  assert.throws(
    () => parseLocalReleaseManifest(JSON.stringify(missingRevision)),
    /exactly the format version 1 keys/,
  );
  assert.throws(
    () => parseLocalReleaseManifest(JSON.stringify({ ...valid, formatVersion: 2 })),
    /formatVersion must be exactly 1/,
  );
  assert.throws(
    () => parseLocalReleaseManifest(JSON.stringify({
      ...valid,
      runtime: { ...valid.runtime, extra: "no" },
    })),
    /runtime must contain exactly/,
  );
  assert.throws(
    () => parseLocalReleaseManifest(JSON.stringify({
      ...valid,
      files: [{ ...valid.files[0], digest: "a".repeat(64) }, ...valid.files.slice(1)],
    })),
    /file must contain exactly/,
  );
});

test("rejects unsafe, duplicate, and Windows-case-colliding manifest paths", () => {
  const valid = releaseManifest("lead-agent", "revision-1", payload);
  for (const path of ["/absolute.js", "../escape.js", "dist/../escape.js", "C:/escape.js", "dist\\main.js"]) {
    assert.throws(
      () => parseLocalReleaseManifest(JSON.stringify({ ...valid, entrypoint: path })),
      /safe Windows-relative path/,
    );
  }
  assert.throws(
    () => parseLocalReleaseManifest(JSON.stringify({
      ...valid,
      files: [...valid.files, { ...valid.files[0]!, path: "DIST/MAIN.JS" }],
    })),
    /duplicated or collides on Windows/,
  );
  assert.throws(
    () => parseLocalReleaseManifest(JSON.stringify({
      ...valid,
      files: [...valid.files, { path: "manifest.json", size: 1, sha256: "a".repeat(64) }],
    })),
    /metadata/,
  );
  assert.throws(
    () => parseLocalReleaseManifest(JSON.stringify({ ...valid, entrypoint: "DIST/MAIN.JS" })),
    /entrypoint must reference a listed file/,
  );
});

test("verifies exact files, bundled runtime, entrypoint, and candidate kind", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-local-release-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  await writeBundle(candidate, releaseManifest("lead-agent", "revision-1", payload), payload);

  const verified = await verifyLocalReleaseCandidate(candidate, "lead-agent");

  assert.equal(verified.identity.kind, "lead-agent");
  assert.equal(verified.identity.revision, "revision-1");
  assert.match(verified.identity.digest, /^[a-f0-9]{64}$/);
  assert.equal(verified.entrypointPath, join(candidate, "dist", "main.js"));
  assert.deepEqual(verified.runtime, {
    version: "24.17.0",
    architecture: "x64",
    path: join(candidate, "runtime", "node.exe"),
  });
  const invalidRuntime = releaseManifest("lead-agent", "runtime-missing", payload);
  invalidRuntime.runtime.path = "missing/node.exe";
  assert.throws(() => parseLocalReleaseManifest(JSON.stringify(invalidRuntime)), /must reference a listed file/);
  const invalidEntrypoint = releaseManifest("lead-agent", "entrypoint-missing", payload);
  invalidEntrypoint.entrypoint = "dist/missing.js";
  assert.throws(() => parseLocalReleaseManifest(JSON.stringify(invalidEntrypoint)), /entrypoint must reference/);
});

test("rejects extra, missing, changed, and case-mismatched files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-local-release-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const extra = join(root, "extra");
  await writeBundle(extra, releaseManifest("lead-agent", "extra", payload), payload);
  await writeFile(join(extra, "undeclared.txt"), "no");
  await assert.rejects(verifyLocalReleaseCandidate(extra, "lead-agent"), /undeclared file/);

  const missing = join(root, "missing");
  await writeBundle(missing, releaseManifest("lead-agent", "missing", payload), payload);
  await rm(join(missing, "dist", "main.js"));
  await assert.rejects(verifyLocalReleaseCandidate(missing, "lead-agent"), /missing a declared file/);

  const changed = join(root, "changed");
  await writeBundle(changed, releaseManifest("lead-agent", "changed", payload), payload);
  await writeFile(join(changed, "dist", "main.js"), "changed bytes");
  await assert.rejects(verifyLocalReleaseCandidate(changed, "lead-agent"), /size changed|digest changed/);

  const wrongCase = join(root, "wrong-case");
  const wrongCasePayload = { ...payload, "Dist/Main.js": payload["dist/main.js"] };
  delete (wrongCasePayload as Partial<typeof wrongCasePayload>)["dist/main.js"];
  await writeBundle(
    wrongCase,
    releaseManifest("lead-agent", "wrong-case", payload),
    wrongCasePayload,
  );
  await assert.rejects(verifyLocalReleaseCandidate(wrongCase, "lead-agent"), /casing does not match/);

  if (process.platform !== "win32") {
    const collidingDirectories = join(root, "colliding-directories");
    const collidingPayload = {
      ...payload,
      "Dist/other.js": Buffer.from("other"),
    };
    await writeBundle(
      collidingDirectories,
      releaseManifest("lead-agent", "colliding-directories", collidingPayload),
      collidingPayload,
    );
    await assert.rejects(
      verifyLocalReleaseCandidate(collidingDirectories, "lead-agent"),
      /paths collide on Windows/,
    );
  }
});

test("rejects symlinks in a candidate without following them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-local-release-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  await writeBundle(candidate, releaseManifest("lead-agent", "linked", payload), payload);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "file.txt"), "outside");
  await symlink(outside, join(candidate, "linked"), "junction");

  await assert.rejects(
    verifyLocalReleaseCandidate(candidate, "lead-agent"),
    /symlink or reparse point/,
  );
});

test("canonical manifest content contributes deterministically to identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-local-release-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first");
  const second = join(root, "second");
  const manifest = releaseManifest("lead-agent", "identity", payload);
  await writeBundle(first, manifest, payload, JSON.stringify(manifest));
  await writeBundle(second, manifest, payload, JSON.stringify(manifest, null, 4));

  const firstIdentity = await verifyLocalReleaseCandidate(first, "lead-agent");
  const secondIdentity = await verifyLocalReleaseCandidate(second, "lead-agent");
  assert.equal(firstIdentity.identity.digest, secondIdentity.identity.digest);

  const changedManifest = { ...manifest, runtime: { ...manifest.runtime, version: "24.17.1" } };
  await writeFile(join(second, "manifest.json"), JSON.stringify(changedManifest));
  const changedIdentity = await verifyLocalReleaseCandidate(second, "lead-agent");
  assert.notEqual(firstIdentity.identity.digest, changedIdentity.identity.digest);
});

test("stages through a temp sibling, is idempotent, and never changes source or an existing version", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-local-release-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "candidate");
  const versions = join(root, "versions");
  const manifest = releaseManifest("lead-agent", "revision-2", payload);
  const sourceManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeBundle(candidate, manifest, payload, sourceManifest);

  const staged = await stageLocalRelease(candidate, versions, "lead-agent");
  assert.equal(staged.path, join(versions, "revision-2"));
  assert.equal((await readFile(join(staged.path, "dist", "main.js"))).toString(), payload["dist/main.js"].toString());
  assert.equal((await lstat(join(staged.path, "dist", "main.js"))).mode & 0o222, 0);
  assert.equal(await readFile(join(candidate, "manifest.json"), "utf8"), sourceManifest);
  assert.deepEqual(
    await stageLocalRelease(candidate, versions, "lead-agent"),
    staged,
  );

  const changedPayload = { ...payload, "dist/main.js": Buffer.from("different release\n") };
  const conflicting = join(root, "conflicting");
  await writeBundle(
    conflicting,
    releaseManifest("lead-agent", "revision-2", changedPayload),
    changedPayload,
  );
  await assert.rejects(
    stageLocalRelease(conflicting, versions, "lead-agent"),
    /already exists with different bytes/,
  );
  assert.equal((await readFile(join(staged.path, "dist", "main.js"))).toString(), payload["dist/main.js"].toString());
});

function releaseManifest(
  kind: LocalReleaseKind,
  revision: string,
  files: Record<string, Buffer>,
): LocalReleaseManifest {
  return {
    formatVersion: 1,
    kind,
    revision,
    entrypoint: "dist/main.js",
    runtime: { version: "24.17.0", architecture: "x64", path: "runtime/node.exe" },
    files: Object.entries(files).map(([path, bytes]) => ({
      path,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
}

async function writeBundle(
  directory: string,
  manifest: LocalReleaseManifest,
  files: Record<string, Buffer>,
  manifestJson = JSON.stringify(manifest),
): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [path, bytes] of Object.entries(files)) {
    const destination = join(directory, ...path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  await writeFile(join(directory, "manifest.json"), manifestJson);
}
