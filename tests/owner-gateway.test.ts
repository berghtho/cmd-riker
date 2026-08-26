import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { connectOwnerGateway } from "../src/owner-gateway/index.ts";
import { localLeadHostAddress, startLocalLeadHost } from "../src/local-host/index.ts";

const gatewayLeadHost = new URL("./support/gateway-lead-host.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");

test("external clients converse with the Lead and observe orchestration through one typed gateway", async (t) => {
  const address = localLeadHostAddress(`C:\\cmd-riker-test-installations\\${randomUUID()}`);
  const server = await startLocalLeadHost({
    address,
    executable: process.execPath,
    args: [gatewayLeadHost],
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
    onStopIntent: async () => {},
  });
  t.after(() => server.stop());

  const gateway = await connectOwnerGateway(address);
  t.after(() => gateway.detach());

  assert.equal(gateway.snapshot.targetProjectPath, "C:\\target-project");
  assert.equal(gateway.snapshot.sessionView?.activeWorkerCount, 1);
  assert.deepEqual(gateway.snapshot.conversation, []);

  const events: unknown[] = [];
  const unsubscribe = gateway.subscribe((event) => events.push(event));
  t.after(unsubscribe);

  const response = await gateway.completeTurn("build it");

  assert.deepEqual(response, { source: "Lead Agent", content: "completed build it\nverified" });
  assert.deepEqual(gateway.snapshot.conversation, [
    { source: "owner", content: "build it" },
    { source: "lead-agent", content: "completed build it\nverified" },
  ]);
  assert(events.some((event) =>
    isEvent(event, "notice") && event.content === "Worker needs input for build it"
  ));
  assert(events.some((event) => isEvent(event, "session-view")));
});

function isEvent(
  value: unknown,
  type: string,
): value is { type: string; content?: string } {
  return typeof value === "object" && value !== null && "type" in value && value.type === type;
}
