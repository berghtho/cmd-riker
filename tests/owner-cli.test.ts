import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { startLocalModel } from "./support/local-model.ts";

test("Owner CLI continues one canonical conversation in a new process", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const localModel = await startLocalModel((call, requestBody) => {
    if (call === 2) {
      const serialized = JSON.stringify(requestBody);
      assert.match(serialized, /Keep this conversation\./);
      assert.match(serialized, /Pinned Pi turn 1\./);
      assert.match(serialized, /Continue after restart\./);
    }
    return `Pinned Pi turn ${call}.`;
  });
  t.after(() => localModel.close());
  await writeFile(
    join(stateDirectory, "config.json"),
    JSON.stringify({
      targetProject: { path: "C:\\target-project" },
      modelSelection: {
        provider: "local-openai",
        model: "owner-model",
        api: "openai-completions",
        baseUrl: localModel.baseUrl,
      },
      modelPolicyRevision: "owner-policy-1",
    }),
  );

  const first = await runCli(stateDirectory, "Keep this conversation.\n");
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Lead Agent: Pinned Pi turn 1\./);

  const second = await runCli(stateDirectory, "Continue after restart.\n");
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Lead Agent: Pinned Pi turn 2\./);
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
    "CMD_RIKER_CONFIG_INVALID: config.json must contain a valid supported Owner configuration.\n",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /Lead Agent:/);
});

test("Owner CLI rejects an unsupported remote Model integration", async (t) => {
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
    "CMD_RIKER_CONFIG_INVALID: config.json must contain a valid supported Owner configuration.\n",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /Lead Agent:/);
});

test("Owner CLI accepts an existing Pi OpenAI Codex login configuration", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-codex-config-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  await writeFile(
    join(stateDirectory, "config.json"),
    JSON.stringify({
      targetProject: { path: "C:\\target-project" },
      modelSelection: {
        provider: "openai-codex",
        model: "gpt-5.4-mini",
        api: "openai-codex-responses",
      },
      modelPolicyRevision: "owner-policy-1",
    }),
  );

  const result = await runCli(stateDirectory, "");

  assert.equal(result.code, 0, result.stderr);
  const state = openAuthoritativeState(stateDirectory);
  assert.deepEqual(state.readOwnerConversation()?.modelSelection, {
    provider: "openai-codex",
    model: "gpt-5.4-mini",
    api: "openai-codex-responses",
  });
  state.close();
});

test("Owner CLI rejects Model URLs that could carry secrets", async (t) => {
  for (const baseUrl of [
    "http://token@127.0.0.1:11434/v1",
    "http://127.0.0.1:11434/v1?api_key=secret",
  ]) {
    await t.test(baseUrl, async (t) => {
      const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-secret-url-test-"));
      t.after(() => rm(stateDirectory, { recursive: true, force: true }));
      await writeFile(
        join(stateDirectory, "config.json"),
        JSON.stringify({
          targetProject: { path: "C:\\target-project" },
          modelSelection: {
            provider: "local-openai",
            model: "owner-model",
            api: "openai-completions",
            baseUrl,
          },
          modelPolicyRevision: "owner-policy-1",
        }),
      );

      const result = await runCli(stateDirectory, "");

      assert.equal(result.code, 2);
      assert.equal(
        result.stderr,
        "CMD_RIKER_CONFIG_INVALID: config.json must contain a valid supported Owner configuration.\n",
      );
    });
  }
});

test("Owner CLI reports an unavailable configured Model without Lead Agent prose", async (t) => {
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

  const result = await runCli(stateDirectory, "Can you hear me?\n");

  assert.equal(result.code, 2);
  assert.equal(
    result.stderr,
    "CMD_RIKER_MODEL_UNAVAILABLE: The configured Model did not complete the turn.\n",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /Lead Agent:/);

  const state = openAuthoritativeState(stateDirectory);
  const messages = state.readOwnerConversation()?.messages;
  assert.equal(messages?.length, 1);
  assert.deepEqual(messages?.[0], {
    sequence: 1,
    role: "owner",
    content: "Can you hear me?",
    turnId: messages?.[0]?.turnId,
    modelSelection: {
      provider: "local-openai",
      model: "missing-local-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  assert.match(messages?.[0]?.turnId ?? "", /^[0-9a-f-]{36}$/);
  state.close();
});

test("Owner CLI cannot activate the deterministic test adapter", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-no-fake-test-"));
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

  const result = await runCli(stateDirectory, "Do not fabricate a response.\n", [
    "--adapter",
    "deterministic",
  ]);

  assert.equal(result.code, 2);
  assert.equal(
    result.stderr,
    "CMD_RIKER_MODEL_UNAVAILABLE: The configured Model did not complete the turn.\n",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /Deterministic turn|Lead Agent:/);
});

function runCli(
  stateDirectory: string,
  input: string,
  extraArguments: readonly string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = ["src/cli.ts", "--state-dir", stateDirectory, ...extraArguments];
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
