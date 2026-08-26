import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import test from "node:test";

import { localLeadHostAddress, startLocalLeadHost } from "../src/local-host/index.ts";
import type { OwnerGatewayProtocolMessage } from "../src/owner-gateway/protocol.ts";

const gatewayLeadHost = new URL("./support/gateway-lead-host.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");
const gatewayCli = new URL("../src/owner-gateway-cli.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");

test("a JSON-lines client receives a versioned snapshot, events, and correlated turn result", async (t) => {
  const installRoot = `C:\\cmd-riker-test-installations\\${randomUUID()}`;
  const server = await startLocalLeadHost({
    address: localLeadHostAddress(installRoot),
    executable: process.execPath,
    args: [gatewayLeadHost],
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
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
    message.type === "turn-result" &&
    message.id === "turn-1" &&
    message.response.content === "completed build it / with the existing constraints\nverified"
  ));

  client.stdin.end();
  const exit = await new Promise<number | null>((resolve) => client.once("exit", resolve));
  assert.equal(exit, 0);
});

async function* messageReader(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<OwnerGatewayProtocolMessage> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    yield JSON.parse(line) as OwnerGatewayProtocolMessage;
  }
}
