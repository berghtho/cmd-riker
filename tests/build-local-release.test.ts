import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { verifyLocalReleaseCandidate } from "../src/local-release/index.ts";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/build-local-release.mjs", import.meta.url));

// The builder accepts the supported Node major at or above the proven floor and
// records the exact supplied runtime version in the manifest.
const minimumNodeVersion = [24, 16, 0] as const;
const nodeVersionMatch = /^v(\d+)\.(\d+)\.(\d+)$/.exec(process.version);
const runtimeSupported = nodeVersionMatch !== null &&
  Number(nodeVersionMatch[1]) === minimumNodeVersion[0] &&
  (Number(nodeVersionMatch[2]) > minimumNodeVersion[1] ||
    (Number(nodeVersionMatch[2]) === minimumNodeVersion[1] &&
      Number(nodeVersionMatch[3]) >= minimumNodeVersion[2])) &&
  (process.arch === "x64" || process.arch === "arm64");
const skip = runtimeSupported
  ? false
  : `requires Node ${minimumNodeVersion.join(".")} or newer on x64/arm64`;

test("builds one complete Lead Agent release bundle with its lifecycle tools", { skip }, async (t) => {
  const fixture = await releaseFixture(t);

  await buildRelease(fixture, "release-37");

  const lead = await verifyLocalReleaseCandidate(
    join(fixture.output, "lead-agent"),
    "lead-agent",
  );
  assert.equal(lead.manifest.entrypoint, "dist/cli.js");
  assert.deepEqual(
    lead.manifest.files.map((file) => file.path),
    [
      "dist/cli.js",
      "dist/lead-support.js",
      "dist/lifecycle-cli.js",
      "dist/owner-client.js",
      "dist/owner-launcher.js",
      "node_modules/runtime-dependency/index.js",
      "node_modules/runtime-dependency/package.json",
      "runtime/node.exe",
    ],
  );
  assert.deepEqual(lead.manifest.runtime, {
    version: process.version.slice(1),
    architecture: process.arch,
    path: "runtime/node.exe",
  });
  assert.deepEqual(
    await readFile(join(fixture.output, "lead-agent", "runtime", "node.exe")),
    await readFile(fixture.node),
  );
});

test("refuses unsafe revisions and never replaces an existing output", { skip }, async (t) => {
  const fixture = await releaseFixture(t);

  await assert.rejects(buildRelease(fixture, "../unsafe"), /safe exact identifier/);
  await buildRelease(fixture, "immutable-1");
  const originalManifest = await readFile(
    join(fixture.output, "lead-agent", "manifest.json"),
    "utf8",
  );

  await assert.rejects(buildRelease(fixture, "immutable-2"), /already exists/);
  assert.equal(
    await readFile(join(fixture.output, "lead-agent", "manifest.json"), "utf8"),
    originalManifest,
  );
});

test("rejects a Lead dist without the lifecycle and Owner tools", { skip }, async (t) => {
  const fixture = await releaseFixture(t, "no-lifecycle");
  await rm(join(fixture.leadDist, "lifecycle-cli.js"));
  await assert.rejects(buildRelease(fixture, "no-lifecycle"), /lifecycle-cli\.js/);
});

async function releaseFixture(t: test.TestContext, suffix = "release") {
  const root = await mkdtemp(join(tmpdir(), `cmd-riker-build-${suffix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const leadDist = join(root, "lead-dist");
  const leadNodeModules = join(root, "lead-node-modules");
  const node = join(root, "runtime", "node.exe");
  await writeFixtureFile(leadDist, "cli.js", "import './lead-support.js';\n");
  await writeFixtureFile(leadDist, "lead-support.js", "export const lead = true;\n");
  await writeFixtureFile(leadDist, "lifecycle-cli.js", "export const lifecycle = true;\n");
  await writeFixtureFile(leadDist, "owner-launcher.js", "export const launcher = true;\n");
  await writeFixtureFile(leadDist, "owner-client.js", "export const client = true;\n");
  await writeFixtureFile(
    leadNodeModules,
    "runtime-dependency/index.js",
    "export const runtimeDependency = true;\n",
  );
  await writeFixtureFile(
    leadNodeModules,
    "runtime-dependency/package.json",
    '{"name":"runtime-dependency","type":"module"}\n',
  );
  await mkdir(dirname(node), { recursive: true });
  await copyFile(process.execPath, node);
  return { root, leadDist, leadNodeModules, node, output: join(root, "output") };
}

async function writeFixtureFile(root: string, relativePath: string, contents: string): Promise<void> {
  const destination = join(root, ...relativePath.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

async function buildRelease(
  fixture: Awaited<ReturnType<typeof releaseFixture>>,
  revision: string,
): Promise<void> {
  try {
    await run(process.execPath, [
      script,
      "--revision",
      revision,
      "--node",
      fixture.node,
      "--lead-dist",
      fixture.leadDist,
      "--lead-node-modules",
      fixture.leadNodeModules,
      "--output",
      fixture.output,
    ]);
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}
