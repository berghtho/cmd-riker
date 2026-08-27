import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const sourceScript = fileURLToPath(new URL("../scripts/build-release.ps1", import.meta.url));

test("release wrapper forwards the selected Node runtime", {
  skip: process.platform === "win32" ? false : "PowerShell release wrapper is Windows-only",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-build-wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "scripts", "build-release.ps1");
  const fakeBin = join(root, "fake-bin");
  const capture = join(root, "npm-arguments.txt");
  await mkdir(dirname(script), { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await copyFile(sourceScript, script);
  await writeFile(
    join(fakeBin, "npm.cmd"),
    `@echo off\r\n>>"%CMD_RIKER_BUILD_CAPTURE%" echo %*\r\n`,
  );
  await writeFile(join(fakeBin, "git.cmd"), `@echo off\r\necho ${"a".repeat(40)}\r\n`);

  await run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Revision",
    "portable-runtime",
    "-NodePath",
    process.execPath,
  ], {
    env: {
      ...process.env,
      CMD_RIKER_BUILD_CAPTURE: capture,
      PATH: `${fakeBin};${process.env.PATH ?? ""}`,
    },
  });

  const invocations = (await readFile(capture, "utf8")).trim().split(/\r?\n/);
  assert.equal(invocations.length, 2);
  assert.match(invocations[1]!, /run build:local-release/);
  assert.ok(invocations[1]!.includes(process.execPath), invocations[1]);
  assert.doesNotMatch(invocations[1]!, /C:\\Tools\\nodejs\\node\.exe/i);
});
