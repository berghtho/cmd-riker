import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("a bound gateway matches a junction and exposes the requested canonical real project path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-gateway-identity-"));
  const project = join(root, "Configured Project");
  const junction = join(root, "project-link");
  await mkdir(project);
  await symlink(project, junction, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rm(root, { recursive: true, force: true }));
  const address = localLeadHostAddress(`C:\\cmd-riker-test-installations\\${randomUUID()}`);
  const server = await startLocalLeadHost({
    address,
    executable: process.execPath,
    args: [gatewayLeadHost],
    env: {
      ...process.env,
      CMD_RIKER_TEST_PROJECTS: JSON.stringify([`${project}${process.platform === "win32" ? "\\." : "/."}`]),
    },
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    onStopIntent: async () => {},
  });
  t.after(() => server.stop());
  const gateway = await connectOwnerGateway(address, {
    projectPath: `${junction.replaceAll("\\", "/")}/`,
  });
  t.after(() => gateway.detach());
  const canonicalPath = await realpath(junction);
  assert.equal(gateway.snapshot.targetProjectPath, canonicalPath);
  assert.equal(gateway.snapshot.sessionView?.projects?.[0]?.path, canonicalPath);
  const conversationTarget = Promise.withResolvers<string>();
  gateway.subscribe((event) => {
    if (event.type === "conversation") conversationTarget.resolve(event.targetProjectPath);
  });

  await gateway.completeTurn("through the junction");

  assert.equal(await conversationTarget.promise, canonicalPath);
});

test("project-bound gateways isolate projects and retain private same-project cursors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-gateway-projects-"));
  const targetProject = join(root, "target-project");
  const secondProject = join(root, "second-project");
  await Promise.all([mkdir(targetProject), mkdir(secondProject)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const address = localLeadHostAddress(`C:\\cmd-riker-test-installations\\${randomUUID()}`);
  const server = await startLocalLeadHost({
    address,
    executable: process.execPath,
    args: [gatewayLeadHost],
    env: {
      ...process.env,
      CMD_RIKER_TEST_PROJECTS: JSON.stringify([targetProject, secondProject]),
    },
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    onStopIntent: async () => {},
  });
  t.after(() => server.stop());
  const targetA = await connectOwnerGateway(address, {
    projectPath: process.platform === "win32" ? targetProject.toUpperCase() : targetProject,
  });
  const targetB = await connectOwnerGateway(address, { projectPath: targetProject });
  const second = await connectOwnerGateway(address, { projectPath: secondProject });
  t.after(async () => {
    await Promise.all([targetA.detach(), targetB.detach(), second.detach()]);
  });

  assert.equal(targetA.snapshot.targetProjectPath, await realpath(targetProject));
  assert.equal(second.snapshot.targetProjectPath, await realpath(secondProject));
  assert.equal(targetA.snapshot.sessionView?.lead?.model, "initial-session-model");
  assert.equal(targetB.snapshot.sessionView?.lead?.model, "initial-session-model");
  const targetBObservedSharedSession = Promise.withResolvers<void>();
  const unsubscribeTargetB = targetB.subscribe((event) => {
    if (event.type === "conversation" && event.conversation[0]?.content === "target only") {
      targetBObservedSharedSession.resolve();
    }
  });
  t.after(unsubscribeTargetB);
  await stage("target turn", targetA.completeTurn("target only"));
  await targetBObservedSharedSession.promise;
  assert.deepEqual(targetA.snapshot.conversation.map((entry) => entry.content), [
    "target only",
    "completed target only\nverified",
  ]);
  assert.deepEqual(targetB.snapshot.conversation, targetA.snapshot.conversation);
  assert.equal(second.snapshot.conversation.length, 0);

  const targetBRevision = targetB.snapshot.ownerSessionRevision;
  await stage("new target session", targetA.completeTurn("/session new"));
  assert.deepEqual(targetA.snapshot.conversation, []);
  assert.equal(targetA.snapshot.ownerSessionRevision, targetBRevision + 1);
  assert.equal(targetB.snapshot.ownerSessionRevision, targetBRevision);
  assert.equal(targetA.snapshot.sessionView?.lead?.model, "new-session-model");
  assert.equal(targetA.snapshot.sessionView?.lead?.contextTokens, 200);
  assert.equal(targetB.snapshot.sessionView?.lead?.model, "initial-session-model");
  assert.equal(targetB.snapshot.sessionView?.lead?.contextTokens, 100);
  assert.deepEqual(targetB.snapshot.conversation.map((entry) => entry.content), [
    "target only",
    "completed target only\nverified",
  ]);

  await stage("second-project turn", second.completeTurn("second only"));
  assert.deepEqual(second.snapshot.conversation.map((entry) => entry.content), [
    "second only",
    "completed second only\nverified",
  ]);
  assert.deepEqual(targetB.snapshot.conversation.map((entry) => entry.content), [
    "target only",
    "completed target only\nverified",
  ]);
});

async function stage<T>(name: string, operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

function isEvent(
  value: unknown,
  type: string,
): value is { type: string; content?: string } {
  return typeof value === "object" && value !== null && "type" in value && value.type === type;
}
