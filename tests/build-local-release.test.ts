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

test("bundles an optional tools tree into the hashed manifest", { skip }, async (t) => {
  const fixture = await releaseFixture(t, "tools");
  const tools = join(fixture.root, "tools-source");
  await writeFixtureFile(tools, "snoretoast/snoretoast-x64.exe", "not-a-real-binary\n");
  await writeFixtureFile(tools, "snoretoast/LICENSE", "LGPL-3.0\n");

  await buildRelease(fixture, "release-with-tools", tools);

  const lead = await verifyLocalReleaseCandidate(
    join(fixture.output, "lead-agent"),
    "lead-agent",
  );
  assert(lead.manifest.files.some((file) => file.path === "tools/snoretoast/snoretoast-x64.exe"));
  assert(lead.manifest.files.some((file) => file.path === "tools/snoretoast/LICENSE"));
  assert.equal(
    await readFile(
      join(fixture.output, "lead-agent", "tools", "snoretoast", "snoretoast-x64.exe"),
      "utf8",
    ),
    "not-a-real-binary\n",
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

test("records the source repository commit for the update notice", { skip }, async (t) => {
  const fixture = await releaseFixture(t, "source");
  const commit = "a".repeat(40);
  await buildRelease(fixture, "source-1", [
    "--source-path",
    fixture.root,
    "--source-commit",
    commit,
  ]);

  const lead = await verifyLocalReleaseCandidate(
    join(fixture.output, "lead-agent"),
    "lead-agent",
  );
  assert.ok(lead.manifest.files.some((file) => file.path === "source.json"));
  const record = JSON.parse(
    await readFile(join(fixture.output, "lead-agent", "source.json"), "utf8"),
  ) as { repositoryPath: string; commit: string };
  assert.equal(record.commit, commit);
  assert.equal(record.repositoryPath, fixture.root);

  const noCommit = await releaseFixture(t, "source-missing");
  await assert.rejects(
    buildRelease(noCommit, "source-2", ["--source-path", noCommit.root]),
    /supplied together/,
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
  toolsOrArguments?: string | string[],
): Promise<void> {
  const extraArguments = toolsOrArguments === undefined
    ? []
    : typeof toolsOrArguments === "string"
      ? ["--tools", toolsOrArguments]
      : toolsOrArguments;
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
      ...extraArguments,
    ]);
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}
