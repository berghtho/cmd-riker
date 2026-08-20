import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { advanceWriteGeneration } from "../src/write-generation.ts";
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
      assert.match(serialized, /comment_on_github_issue/);
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

  const policyState = openAuthoritativeState(stateDirectory);
  const durableConversation = policyState.readOwnerConversation();
  assert.ok(durableConversation);
  const { messages: _messages, ...durableConfiguration } = durableConversation;
  policyState.replaceOwnerConfiguration({
    ...durableConfiguration,
    modelPolicyRevision: "owner-policy-2",
  });
  policyState.close();

  await writeFile(
    join(stateDirectory, "config.json"),
    JSON.stringify({
      targetProject: { path: "C:\\target-project" },
      forgeAuthorities: {
        github: { account: "owner-login", repository: "owner/repository" },
      },
      modelSelection: {
        provider: "local-openai",
        model: "owner-model",
        api: "openai-completions",
        baseUrl: localModel.baseUrl,
      },
      modelPolicyRevision: "owner-policy-1",
    }),
  );

  const second = await runCli(stateDirectory, "Continue after restart.\n");
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Lead Agent: Pinned Pi turn 2\./);
  const state = openAuthoritativeState(stateDirectory);
  assert.deepEqual(state.readOwnerConversation()?.forgeAuthorities, {
    github: { account: "owner-login", repository: "owner/repository" },
  });
  assert.equal(state.readOwnerConversation()?.modelPolicyRevision, "owner-policy-2");
  state.close();
});

test("Owner CLI carries one attributed Commitment to objective Acceptance", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-commitment-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const localModel = await startLocalModel((call, requestBody) => {
    if (call === 1) {
      assert.match(JSON.stringify(requestBody), /record_commitment/);
      return {
        toolCall: {
          id: "commitment-call-1",
          name: "record_commitment",
          arguments: {
            outcome: "Reply with the exact requested phrase.",
            criteria: [
              {
                kind: "response-includes",
                description: "The response includes Engage.",
                expectedText: "Engage.",
              },
            ],
          },
        },
      };
    }
    return "Engage.";
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
      modelFallbacks: [],
      modelPolicyRevision: "owner-policy-1",
    }),
  );

  const result = await runCli(stateDirectory, "Reply with Engage and own that outcome.\n");

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Lead Agent: Engage\./);
  assert.match(result.stdout, /Commitment [0-9a-f-]{36} accepted:/);
  const state = openAuthoritativeState(stateDirectory);
  const commitment = state.readCommitments()[0];
  assert.equal(commitment?.state, "accepted");
  assert.equal(commitment?.acceptance?.authority, "lead-agent");
  assert.deepEqual(state.readOwnerConversation()?.messages.at(-1)?.modelSelection, {
    provider: "local-openai",
    model: "owner-model",
    api: "openai-completions",
    baseUrl: localModel.baseUrl,
  });
  state.close();
});

test("Owner CLI leaves subjective work for a later explicit Owner Acceptance", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-owner-acceptance-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const localModel = await startLocalModel((call, requestBody) => {
    if (call === 1) {
      return {
        toolCall: {
          id: "commitment-call-subjective",
          name: "record_commitment",
          arguments: {
            outcome: "Propose a product name for Owner judgment.",
            criteria: [
              {
                kind: "owner-judgment",
              },
            ],
          },
        },
      };
    }
    if (call === 2) return "I propose Riker.";
    if (call === 3) {
      const commitmentId = JSON.stringify(requestBody).match(
        /([0-9a-f-]{36}): awaiting-acceptance/,
      )?.[1];
      assert(commitmentId);
      return {
        toolCall: {
          id: "commitment-call-accept",
          name: "accept_commitment",
          arguments: { commitmentId },
        },
      };
    }
    return "Owner Acceptance recorded.";
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
      modelFallbacks: [],
      modelPolicyRevision: "owner-policy-1",
    }),
  );

  const result = await runCli(
    stateDirectory,
    "Propose a product name and let me judge it.\nI explicitly accept that proposal.\n",
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /awaiting Owner Acceptance/);
  assert.match(result.stdout, /Commitment [0-9a-f-]{36} accepted:/);
  const state = openAuthoritativeState(stateDirectory);
  const commitment = state.readCommitments()[0];
  assert.equal(commitment?.state, "accepted");
  assert.equal(commitment?.acceptance?.authority, "owner");
  assert.equal(
    commitment?.acceptance?.authority === "owner"
      ? commitment.acceptance.ownerTurnId
      : undefined,
    state.readOwnerConversation()?.messages[2]?.turnId,
  );
  state.close();
});

test("Owner CLI uses the first policy-compliant fallback and attributes the completed turn", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-fallback-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const failingModel = await startLocalModel(() => ({ errorStatus: 503 }));
  t.after(() => failingModel.close());
  const localModel = await startLocalModel(() => "Fallback response.");
  t.after(() => localModel.close());
  await writeFile(
    join(stateDirectory, "config.json"),
    JSON.stringify({
      targetProject: { path: "C:\\target-project" },
      modelSelection: {
        provider: "local-openai",
        model: "owner-model",
        api: "openai-completions",
        baseUrl: failingModel.baseUrl,
      },
      modelFallbacks: [
        {
          provider: "local-openai",
          model: "owner-model",
          api: "openai-completions",
          baseUrl: localModel.baseUrl,
        },
      ],
      modelPolicyRevision: "owner-policy-2",
    }),
  );

  const result = await runCli(stateDirectory, "Use the available Model.\n");

  assert.equal(result.code, 0, result.stderr);
  const state = openAuthoritativeState(stateDirectory);
  const response = state.readOwnerConversation()?.messages.at(-1);
  assert.equal(response?.role, "lead-agent");
  assert.deepEqual(response?.modelSelection, {
    provider: "local-openai",
    model: "owner-model",
    api: "openai-completions",
    baseUrl: localModel.baseUrl,
  });
  assert.equal(response?.modelPolicyRevision, "owner-policy-2");
  assert.equal(response?.selectionReason, "fallback-after-ineligible-candidate");
  const attempts = state.readLeadTurnAttempts();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.status, "failed");
  assert.equal(attempts[0]?.failureKind, "unavailable");
  assert.equal(attempts[1]?.status, "completed");
  assert.deepEqual(attempts[1]?.modelSelection, response?.modelSelection);
  state.close();
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

test("Owner CLI reports a fenced installed generation without opening conversation", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-generation-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
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
  advanceWriteGeneration(stateDirectory, 1);

  const result = await runCli(stateDirectory, "", ["--write-generation", "1"]);

  assert.equal(result.code, 2);
  assert.equal(
    result.stderr,
    "CMD_RIKER_STALE_GENERATION: This Lead Agent process is fenced from Authoritative State generation 2.\n",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /Lead Agent:/);
  const active = openAuthoritativeState(stateDirectory, { writeGeneration: 2 });
  active.close();
});

test("provisional activation reports readiness without requiring live Model availability", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-provisional-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  state.close();

  const result = await runCli(stateDirectory, "", [
    "--write-generation",
    "1",
    "--activation-provisional",
    "--activation-handshake-nonce",
    "nonce-1",
    "--activation-attempt-id",
    "attempt-1",
    "--candidate-revision",
    "candidate-1",
    "--artifact-digest",
    "digest-1",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /"type":"CMD_RIKER_ACTIVATION_READY".*"attemptId":"attempt-1".*"handshakeNonce":"nonce-1"/,
  );
});

test("hosted Session View inspection acknowledges handling without inventing a durable Owner turn", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-hosted-session-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const state = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  state.close();

  const result = await runCli(stateDirectory, "/session workers\n", [
    "--write-generation",
    "1",
    "--activation-provisional",
    "--hosted",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /CMD_RIKER_OWNER_HANDLED/);
  assert.doesNotMatch(result.stdout, /CMD_RIKER_OWNER_RECORDED:/);
  const reopened = openAuthoritativeState(stateDirectory, { writeGeneration: 1 });
  assert.deepEqual(reopened.readOwnerConversation()?.messages, []);
  reopened.close();
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
      workerModelPolicy: {
        revision: "worker-policy-1",
        selection: {
          provider: "openai",
          model: "gpt-5.6-sol",
          nativeHarness: "codex",
        },
      },
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
  assert.deepEqual(state.readOwnerConversation()?.workerModelPolicy, {
    revision: "worker-policy-1",
    selection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      nativeHarness: "codex",
    },
  });
  state.close();
});

test("Owner CLI accepts Claude and Copilot Worker Model Policies", async (t) => {
  const selections = [
    { provider: "anthropic", model: "claude-sonnet-5", nativeHarness: "claude" },
    { provider: "github", model: "auto", nativeHarness: "copilot" },
  ] as const;

  for (const selection of selections) {
    await t.test(selection.nativeHarness, async (t) => {
      const stateDirectory = await mkdtemp(
        join(tmpdir(), `cmd-riker-cli-${selection.nativeHarness}-config-test-`),
      );
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
          workerModelPolicy: {
            revision: `${selection.nativeHarness}-policy-1`,
            selection,
          },
        }),
      );

      const result = await runCli(stateDirectory, "");

      assert.equal(result.code, 0, result.stderr);
      const state = openAuthoritativeState(stateDirectory);
      assert.deepEqual(state.readOwnerConversation()?.workerModelPolicy, {
        revision: `${selection.nativeHarness}-policy-1`,
        selection,
      });
      state.close();
    });
  }
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
  const failingModel = await startLocalModel(() => ({ errorStatus: 503 }));
  t.after(() => failingModel.close());
  await writeFile(
    join(stateDirectory, "config.json"),
    JSON.stringify({
      targetProject: { path: "C:\\target-project" },
      modelSelection: {
        provider: "local-openai",
        model: "owner-model",
        api: "openai-completions",
        baseUrl: failingModel.baseUrl,
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
      model: "owner-model",
      api: "openai-completions",
      baseUrl: failingModel.baseUrl,
    },
    modelPolicyRevision: "owner-policy-1",
    nativeHarness: null,
  });
  assert.match(messages?.[0]?.turnId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(state.readLeadTurnAttempts()[0]?.status, "failed");
  state.close();
});

test("Owner CLI cannot activate the deterministic test adapter", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-cli-no-fake-test-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const failingModel = await startLocalModel(() => ({ errorStatus: 503 }));
  t.after(() => failingModel.close());
  await writeFile(
    join(stateDirectory, "config.json"),
    JSON.stringify({
      targetProject: { path: "C:\\target-project" },
      modelSelection: {
        provider: "local-openai",
        model: "owner-model",
        api: "openai-completions",
        baseUrl: failingModel.baseUrl,
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
