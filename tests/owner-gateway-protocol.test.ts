import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { localLeadHostAddress, startLocalLeadHost } from "../src/local-host/index.ts";
import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import type { OwnerGatewayProtocolMessage } from "../src/owner-gateway/protocol.ts";
import { startLocalModel } from "./support/local-model.ts";

const gatewayLeadHost = new URL("./support/gateway-lead-host.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");
const gatewayCli = new URL("../src/owner-gateway-cli.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");
const leadCli = new URL("../src/cli.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");

test("a JSON-lines client receives a versioned snapshot, events, and correlated turn result", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cmd-riker-gateway-protocol-project-"));
  const targetProject = join(projectRoot, "target-project");
  await mkdir(targetProject);
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const installRoot = `C:\\cmd-riker-test-installations\\${randomUUID()}`;
  const server = await startLocalLeadHost({
    address: localLeadHostAddress(installRoot),
    executable: process.execPath,
    args: [gatewayLeadHost],
    env: { ...process.env, CMD_RIKER_TEST_PROJECTS: JSON.stringify([targetProject]) },
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    onStopIntent: async () => {},
  });
  t.after(() => server.stop());

  const client = spawn(process.execPath, [
    gatewayCli,
    "--install-root",
    installRoot,
    "--project",
    targetProject,
  ], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => client.kill());
  const messages = messageReader(client.stdout);

  const ready = await messages.next();
  assert.equal(ready.value?.type, "ready");
  assert.equal(ready.value?.protocolVersion, 2);
  assert.equal(ready.value?.snapshot.targetProjectPath, await realpath(targetProject));
  assert.doesNotMatch(JSON.stringify(ready.value), /workerSessionId|workItemId|standingOrderId|sessionId/);

  client.stdin.write(`${JSON.stringify({
    id: "turn-1",
    type: "turn",
    content: "build it\nwith the existing constraints",
  })}\n`);

  const observed: OwnerGatewayProtocolMessage[] = [];
  while (!observed.some((message) => message.type === "turn-result")) {
    const next = await messages.next();
    assert.equal(next.done, false);
    observed.push(next.value!);
  }
  assert.equal(
    observed.some((message) => message.type === "event" && message.event.type === "notice"),
    false,
  );
  assert(observed.some((message) =>
    message.type === "event" &&
    message.event.type === "lead-state" &&
    message.event.state === "responding"
  ));
  assert.doesNotMatch(JSON.stringify(observed), /workerSessionId|workItemId|standingOrderId|sessionId/);
  assert(observed.some((message) =>
    message.type === "turn-result" &&
    message.id === "turn-1" &&
    message.response.content === "completed build it / with the existing constraints\nverified"
  ));

  client.stdin.end();
  const exit = await new Promise<number | null>((resolve) => client.once("exit", resolve));
  assert.equal(exit, 0);
});

test("the gateway completes a turn through the real hosted Lead process", async (t) => {
  const installRoot = `C:\\cmd-riker-test-installations\\${randomUUID()}`;
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-owner-gateway-state-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "cmd-riker-real-gateway-projects-"));
  const targetProject = join(projectRoot, "target-project");
  const secondProject = join(projectRoot, "second-project");
  await Promise.all([mkdir(targetProject), mkdir(secondProject)]);
  const localModel = await startLocalModel(() => "Real hosted gateway response.");
  await writeFile(join(stateDirectory, "config.json"), JSON.stringify({
    targetProject: { path: targetProject },
    projects: [{ name: "second", path: secondProject }],
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: localModel.baseUrl,
    },
    modelPolicyRevision: "owner-policy-1",
  }));
  const server = await startLocalLeadHost({
    address: localLeadHostAddress(installRoot),
    executable: process.execPath,
    args: [leadCli, "--state-dir", stateDirectory, "--hosted"],
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    ownerHandledMarker: "CMD_RIKER_OWNER_HANDLED",
    encodeOwnerInput: true,
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    onStopIntent: async () => {},
  });
  const client = spawn(process.execPath, [
    gatewayCli,
    "--install-root",
    installRoot,
    "--project",
    process.platform === "win32" ? secondProject.toUpperCase() : secondProject,
  ], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let clientStderr = "";
  client.stderr.setEncoding("utf8").on("data", (chunk: string) => { clientStderr += chunk; });
  t.after(async () => {
    if (client.exitCode === null) client.kill();
    await server.stop();
    await localModel.close();
    await rm(stateDirectory, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });
  const messages = messageReader(client.stdout);
  const ready = (await messages.next()).value;
  assert.equal(ready?.type, "ready", clientStderr);
  if (ready?.type === "ready") {
    assert.equal(ready.snapshot.targetProjectPath, await realpath(secondProject));
  }
  let state = openAuthoritativeState(stateDirectory);
  assert.deepEqual(state.readOwnerSessions(), []);
  state.close();

  client.stdin.write(`${JSON.stringify({
    id: "cross-project-session",
    type: "turn",
    content: "/session new target-project",
  })}\n`);
  let rejectedJump: OwnerGatewayProtocolMessage | undefined;
  while (rejectedJump?.type !== "turn-result") {
    const next = await messages.next();
    assert.equal(next.done, false);
    rejectedJump = next.value;
  }
  assert.equal(rejectedJump.response.source, "Session View");
  assert.match(rejectedJump.response.content, /Unknown project/);
  state = openAuthoritativeState(stateDirectory);
  assert.deepEqual(state.readOwnerSessions(), []);
  state.close();

  client.stdin.write(`${JSON.stringify({
    id: "real-turn",
    type: "turn",
    content: "Use the real Lead runtime.",
  })}\n`);
  let result: OwnerGatewayProtocolMessage | undefined;
  while (result?.type !== "turn-result") {
    const next = await messages.next();
    assert.equal(next.done, false);
    result = next.value;
  }
  assert.equal(result.id, "real-turn");
  assert.equal(result.response.content, "Real hosted gateway response.");
  client.stdin.end();
  assert.equal(await new Promise<number | null>((resolve) => client.once("exit", resolve)), 0);
  state = openAuthoritativeState(stateDirectory);
  assert.equal(state.readOwnerSessions()[0]?.projectPath, secondProject);
  state.close();
});

test("gateway mode requires an absolute configured project and rejects unknown projects before ready", async (t) => {
  const missing = spawn(process.execPath, [gatewayCli, "--install-root", "C:\\missing"], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const missingOutput = await collectProcess(missing);
  assert.equal(missingOutput.code, 2);
  assert.match(missingOutput.stderr, /--project is required/);
  assert.equal(missingOutput.stdout, "");

  const installRoot = `C:\\cmd-riker-test-installations\\${randomUUID()}`;
  const projectRoot = await mkdtemp(join(tmpdir(), "cmd-riker-gateway-rejection-projects-"));
  const configuredProject = join(projectRoot, "configured");
  const unknownProject = join(projectRoot, "unknown");
  await Promise.all([mkdir(configuredProject), mkdir(unknownProject)]);
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const server = await startLocalLeadHost({
    address: localLeadHostAddress(installRoot),
    executable: process.execPath,
    args: [gatewayLeadHost],
    env: { ...process.env, CMD_RIKER_TEST_PROJECTS: JSON.stringify([configuredProject]) },
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    onStopIntent: async () => {},
  });
  t.after(() => server.stop());
  const unknown = spawn(process.execPath, [
    gatewayCli,
    "--install-root",
    installRoot,
    "--project",
    unknownProject,
  ], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const unknownOutput = await collectProcess(unknown);
  assert.equal(unknownOutput.code, 2);
  assert.equal(unknownOutput.stdout, "");
  assert.match(unknownOutput.stderr, /Unknown configured project path/);

  const nonexistent = spawn(process.execPath, [
    gatewayCli,
    "--install-root",
    installRoot,
    "--project",
    join(projectRoot, "does-not-exist"),
  ], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const nonexistentOutput = await collectProcess(nonexistent);
  assert.equal(nonexistentOutput.code, 2);
  assert.equal(nonexistentOutput.stdout, "");
  assert.match(nonexistentOutput.stderr, /ENOENT|no such file or directory/i);

  const invalidInstallRoot = `C:\\cmd-riker-test-installations\\${randomUUID()}`;
  const invalidServer = await startLocalLeadHost({
    address: localLeadHostAddress(invalidInstallRoot),
    executable: process.execPath,
    args: [gatewayLeadHost],
    env: {
      ...process.env,
      CMD_RIKER_TEST_PROJECTS: JSON.stringify([join(projectRoot, "missing-configured")]),
    },
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    onStopIntent: async () => {},
  });
  t.after(() => invalidServer.stop());
  const invalidConfigured = spawn(process.execPath, [
    gatewayCli,
    "--install-root",
    invalidInstallRoot,
    "--project",
    configuredProject,
  ], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const invalidConfiguredOutput = await collectProcess(invalidConfigured);
  assert.equal(invalidConfiguredOutput.code, 2);
  assert.equal(invalidConfiguredOutput.stdout, "");
  assert.match(invalidConfiguredOutput.stderr, /ENOENT|no such file or directory/i);
});

async function* messageReader(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<OwnerGatewayProtocolMessage> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    yield JSON.parse(line) as OwnerGatewayProtocolMessage;
  }
}

function collectProcess(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  return new Promise((resolve) => child.once("exit", (code) => resolve({ code, stdout, stderr })));
}
