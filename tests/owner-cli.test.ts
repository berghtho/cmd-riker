import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";

test("Owner CLI continues one canonical conversation in a new process", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  await writeFile(
    join(stateDirectory, "config.json"),
    JSON.stringify({
      targetProject: { path: "C:\\target-project" },
      modelSelection: {
        provider: "local-openai",
        model: "owner-model",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
      },
      modelPolicyRevision: "owner-policy-1",
    }),
  );

  const first = await runCli(stateDirectory, "Keep this conversation.\n");
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Lead Agent: Deterministic turn 1: Keep this conversation\./);

  const second = await runCli(stateDirectory, "Continue after restart.\n");
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Lead Agent: Deterministic turn 2: Continue after restart\./);
});

test("Owner CLI reports missing configuration as a deterministic host diagnostic", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-missing-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));

  const result = await runCli(stateDirectory, "");

  assert.equal(result.code, 2);
  assert.equal(
    result.stderr,
    "CMD_RIKER_CONFIG_MISSING: Uninitialized state requires config.json in the state directory.\n",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /Lead Agent:/);
});

test("Owner CLI reports malformed configuration as a deterministic host diagnostic", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-invalid-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  await writeFile(join(stateDirectory, "config.json"), "{not json");

  const result = await runCli(stateDirectory, "");

  assert.equal(result.code, 2);
  assert.equal(
    result.stderr,
    "CMD_RIKER_CONFIG_INVALID: config.json must contain a valid secret-free Owner configuration.\n",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /Lead Agent:/);
});

test("Owner CLI rejects a model configuration that is not secret-free", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-secret-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  await writeFile(
    join(stateDirectory, "config.json"),
    JSON.stringify({
      targetProject: { path: "C:\\target-project" },
      modelSelection: {
        provider: "remote-provider",
        model: "owner-model",
        api: "openai-completions",
        baseUrl: "https://models.example.test/v1",
      },
      modelPolicyRevision: "owner-policy-1",
    }),
  );

  const result = await runCli(stateDirectory, "");

  assert.equal(result.code, 2);
  assert.equal(
    result.stderr,
    "CMD_RIKER_CONFIG_INVALID: config.json must contain a valid secret-free Owner configuration.\n",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /Lead Agent:/);
});

test("Owner CLI reports an unavailable configured Model without assistant prose", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-model-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  await writeFile(
    join(stateDirectory, "config.json"),
    JSON.stringify({
      targetProject: { path: "C:\\target-project" },
      modelSelection: {
        provider: "local-openai",
        model: "missing-local-model",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
      },
      modelPolicyRevision: "owner-policy-1",
    }),
  );

  const result = await runCli(stateDirectory, "Can you hear me?\n", "production");

  assert.equal(result.code, 2);
  assert.equal(
    result.stderr,
    "CMD_RIKER_MODEL_UNAVAILABLE: The configured Model did not complete the turn.\n",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /Lead Agent:/);

  const state = openAuthoritativeState(stateDirectory);
  assert.deepEqual(state.readOwnerConversation()?.messages, [
    { sequence: 1, role: "owner", content: "Can you hear me?" },
  ]);
  state.close();
});

function runCli(
  stateDirectory: string,
  input: string,
  adapter: "deterministic" | "production" = "deterministic",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["src/cli.ts", "--state-dir", stateDirectory];
    if (adapter === "deterministic") args.push("--adapter", "deterministic");
    const child = spawn(
      process.execPath,
      args,
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
