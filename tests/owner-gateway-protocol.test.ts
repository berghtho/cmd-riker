import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { localLeadHostAddress, startLocalLeadHost } from "../src/local-host/index.ts";
import type { OwnerGatewayProtocolMessage } from "../src/owner-gateway/protocol.ts";
import { startLocalModel } from "./support/local-model.ts";

const gatewayLeadHost = new URL("./support/gateway-lead-host.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");
const gatewayCli = new URL("../src/owner-gateway-cli.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");
const leadCli = new URL("../src/cli.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");

test("a JSON-lines client receives a versioned snapshot, events, and correlated turn result", async (t) => {
  const installRoot = `C:\\cmd-riker-test-installations\\${randomUUID()}`;
  const server = await startLocalLeadHost({
    address: localLeadHostAddress(installRoot),
    executable: process.execPath,
    args: [gatewayLeadHost],
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    onStopIntent: async () => {},
  });
  t.after(() => server.stop());

  const client = spawn(process.execPath, [gatewayCli, "--install-root", installRoot], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => client.kill());
  const messages = messageReader(client.stdout);

  const ready = await messages.next();
  assert.equal(ready.value?.type, "ready");
  assert.equal(ready.value?.protocolVersion, 1);
  assert.equal(ready.value?.snapshot.targetProjectPath, "C:\\target-project");
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
  assert(observed.some((message) =>
    message.type === "event" &&
    message.event.type === "notice" &&
    message.event.content === "Worker needs input for build it / with the existing constraints"
  ));
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
  const localModel = await startLocalModel(() => "Real hosted gateway response.");
  await writeFile(join(stateDirectory, "config.json"), JSON.stringify({
    targetProject: { path: "C:\\target-project" },
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
  const client = spawn(process.execPath, [gatewayCli, "--install-root", installRoot], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    if (client.exitCode === null) client.kill();
    await server.stop();
    await localModel.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const messages = messageReader(client.stdout);
  assert.equal((await messages.next()).value?.type, "ready");

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
});

async function* messageReader(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<OwnerGatewayProtocolMessage> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    yield JSON.parse(line) as OwnerGatewayProtocolMessage;
  }
}
