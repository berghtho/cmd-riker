import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ownerLauncher = new URL("../src/owner-launcher.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");

test("riker gateway starts the protected host and reserves stdout for protocol records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-owner-launcher-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcherDirectory = join(root, "launcher");
  const bundleDirectory = join(root, "bundle");
  const lifecycleMarker = join(root, "lifecycle-started.txt");
  await mkdir(launcherDirectory, { recursive: true });
  await mkdir(bundleDirectory, { recursive: true });
  const lifecycle = join(bundleDirectory, "lifecycle.mjs");
  const gateway = join(bundleDirectory, "gateway.mjs");
  await writeFile(
    lifecycle,
    `import { writeFile } from "node:fs/promises";\n` +
      `await writeFile(${JSON.stringify(lifecycleMarker)}, "started");\n` +
      `process.stdout.write("not protocol\\n");\n`,
  );
  await writeFile(
    gateway,
    `process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 2, args: process.argv.slice(2) }) + "\\n");\n`,
  );
  await writeFile(join(launcherDirectory, "installation.json"), JSON.stringify({
    leadAgent: {
      path: bundleDirectory,
      runtimePath: process.execPath,
      lifecyclePath: lifecycle,
      ownerGatewayPath: gateway,
    },
  }));

  const result = await run(process.execPath, [
    ownerLauncher,
    "--install-root",
    root,
    "gateway",
    "--project",
    "C:\\repos\\bound-project",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    type: "ready",
    protocolVersion: 2,
    args: ["--install-root", root, "--project", "C:\\repos\\bound-project"],
  });
  assert.equal(await readFile(lifecycleMarker, "utf8"), "started");

  const missingProject = await run(process.execPath, [
    ownerLauncher,
    "--install-root",
    root,
    "gateway",
  ]);
  assert.equal(missingProject.code, 2);
  assert.equal(missingProject.stdout, "");
  assert.match(missingProject.stderr, /--project is required for gateway mode/);
});

function run(
  executable: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
