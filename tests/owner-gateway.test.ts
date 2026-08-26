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
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    transcriptByteLimit: 256,
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

  const secondGateway = await connectOwnerGateway(address);
  t.after(() => secondGateway.detach());
  const [firstConcurrent, secondConcurrent] = await Promise.all([
    gateway.completeTurn("first concurrent turn"),
    secondGateway.completeTurn("second concurrent turn"),
  ]);
  assert.equal(firstConcurrent.content, "completed first concurrent turn\nverified");
  assert.equal(secondConcurrent.content, "completed second concurrent turn\nverified");

  const initialRevision = gateway.snapshot.ownerSessionRevision;
  await gateway.completeTurn("/session new second-project");
  assert.deepEqual(gateway.snapshot.conversation, []);
  assert.equal(gateway.snapshot.targetProjectPath, "C:\\second-project");
  assert.equal(gateway.snapshot.ownerSessionRevision, initialRevision + 1);
  await gateway.completeTurn("new session turn");
  assert.deepEqual(gateway.snapshot.conversation, [
    { source: "owner", content: "new session turn" },
    { source: "lead-agent", content: "completed new session turn\nverified" },
  ]);

  const slowTurn = gateway.completeTurn("slow turn");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gateway.snapshot.leadState, "responding");
  const attachedWhileResponding = await connectOwnerGateway(address);
  t.after(() => attachedWhileResponding.detach());
  assert.equal(attachedWhileResponding.snapshot.leadState, "responding");
  await slowTurn;
  assert.equal(gateway.snapshot.leadState, "available");
});

test("host exit before durable acknowledgement rejects one turn without an unhandled rejection", async (t) => {
  const address = localLeadHostAddress(`C:\\cmd-riker-test-installations\\${randomUUID()}`);
  const server = await startLocalLeadHost({
    address,
    executable: process.execPath,
    args: [gatewayLeadHost],
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    onStopIntent: async () => {},
  });
  t.after(() => server.stop());
  const gateway = await connectOwnerGateway(address);
  t.after(() => gateway.detach());
  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", recordUnhandled);
  t.after(() => process.off("unhandledRejection", recordUnhandled));

  await assert.rejects(
    gateway.completeTurn("exit before durable acknowledgement"),
    /exited before (?:Owner input became durable|the Owner turn completed)|connection closed/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

function isEvent(
  value: unknown,
  type: string,
): value is { type: string; content?: string } {
  return typeof value === "object" && value !== null && "type" in value && value.type === type;
}
