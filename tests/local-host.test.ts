import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import test from "node:test";

import {
  connectLocalLeadHost,
  localLeadHostAddress,
  startLocalLeadHost,
  type LeadHostTranscriptEntry,
  type LocalLeadHostClient,
  type LocalLeadHostServer,
} from "../src/local-host/index.ts";
import {
  decodeHostedOwnerInput,
  encodeHostedOwnerInput,
} from "../src/owner-host-framing.ts";

const echoLeadHost = new URL("./support/echo-lead-host.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");
const gatewayLeadHost = new URL("./support/gateway-lead-host.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");

test("scoped hosted framing carries project and private session cursor on one physical line", () => {
  const encoded = encodeHostedOwnerInput("first\nsecond", {
    targetProjectPath: "C:\\target-project",
    sessionId: "internal-session",
  });
  assert.equal(encoded.includes("\n"), false);
  assert.deepEqual(decodeHostedOwnerInput(encoded), {
    content: "first\nsecond",
    targetProjectPath: "C:\\target-project",
    sessionId: "internal-session",
  });
});

test("the local host returns the child-selected private session cursor for a scoped turn", async (t) => {
  const server = await startLocalLeadHost({
    address: testAddress(),
    executable: process.execPath,
    args: [gatewayLeadHost],
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    onStopIntent: async () => {},
  });
  t.after(() => server.stop());
  const client = await connectLocalLeadHost(server.address);
  t.after(() => client.detach());

  const result = await client.completeScopedOwnerTurn("scoped turn", {
    targetProjectPath: "C:\\target-project",
  });

  assert.equal(result.sessionId, "target-session-1");
  assert.equal(result.response.content, "completed scoped turn\nverified");
});

test("malformed scoped turn fields return request-error without becoming unscoped input", async (t) => {
  const server = await startLocalLeadHost({
    address: testAddress(),
    executable: process.execPath,
    args: [gatewayLeadHost],
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    onStopIntent: async () => {},
  });
  t.after(() => server.stop());
  const socket = createConnection(server.address);
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const lines = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
  socket.write(`${JSON.stringify({ type: "attach" })}\n`);
  assert.equal(JSON.parse((await lines.next()).value!).type, "attached");

  const malformed = [
    { type: "turn", requestId: 41, input: "numeric path", targetProjectPath: 7 },
    { type: "turn", requestId: 42, input: "orphan cursor", sessionId: "private" },
    { type: "turn", requestId: 43, input: "relative path", targetProjectPath: "relative" },
    {
      type: "turn",
      requestId: 44,
      input: "empty cursor",
      targetProjectPath: "C:\\target-project",
      sessionId: "",
    },
  ];
  for (const request of malformed) {
    socket.write(`${JSON.stringify(request)}\n`);
    const response = JSON.parse((await lines.next()).value!);
    assert.equal(response.type, "request-error");
    assert.equal(response.requestId, request.requestId);
  }

  const observer = await connectLocalLeadHost(server.address);
  t.after(() => observer.detach());
  assert.equal(
    observer.transcript.some((entry) =>
      entry.source === "owner" && malformed.some((request) => request.input === entry.line)
    ),
    false,
  );
});

test("sticky scoped projections retain only the latest session per project", async (t) => {
  const server = await startLocalLeadHost({
    address: testAddress(),
    executable: process.execPath,
    args: [gatewayLeadHost],
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    encodeOwnerInput: true,
    ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    transcriptByteLimit: 1,
    onStopIntent: async () => {},
  });
  t.after(() => server.stop());
  const client = await connectLocalLeadHost(server.address);
  let sessionId: string | undefined;
  for (let index = 0; index < 12; index += 1) {
    const result = await client.completeScopedOwnerTurn("/session new", {
      targetProjectPath: "C:\\target-project",
      ...(sessionId ? { sessionId } : {}),
    });
    sessionId = result.sessionId;
  }
  await client.detach();

  const attached = await connectLocalLeadHost(server.address);
  t.after(() => attached.detach());
  assert.equal(
    attached.transcript.filter((entry) =>
      entry.source === "lead" && entry.line.startsWith("CMD_RIKER_OWNER_CONVERSATION:")
    ).length,
    2,
  );
  assert.equal(
    attached.transcript.filter((entry) =>
      entry.source === "lead" && entry.line.startsWith("CMD_RIKER_OWNER_SESSION_VIEW:")
    ).length,
    2,
  );
});

test("one child continues work while its client detaches and reconnects", async (t) => {
  const server = await startTestHost();
  t.after(() => server.stop());
  const first = await connectLocalLeadHost(server.address);
  await waitForLeadLine(first, `lead-ready:${server.childPid}`);

  await first.sendOwnerLine("work:survey");
  await waitForLeadLine(first, "lead-started:survey");
  await first.detach();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const reconnected = await connectLocalLeadHost(server.address);
  assert.equal(reconnected.childPid, server.childPid);
  assert.equal(leadLines(reconnected).filter((line) => line.startsWith("lead-ready:")).length, 1);
  assert(leadLines(reconnected).includes("lead-finished:survey"));
  await reconnected.sendOwnerLine("continue");
  await waitForLeadLine(reconnected, "lead:continue");
});

test("attached clients share replayed conversation and live output", async (t) => {
  const server = await startTestHost({
    transcriptSeed: [{ source: "owner", line: "durable conversation before restart" }],
  });
  t.after(() => server.stop());
  const first = await connectLocalLeadHost(server.address);
  await waitForLeadLine(first, `lead-ready:${server.childPid}`);
  await first.sendOwnerLine("first attached turn");
  await waitForLeadLine(first, "lead:first attached turn");

  const second = await connectLocalLeadHost(server.address);
  assert.deepEqual(second.transcript, first.transcript);
  assert(second.transcript.some((entry) => entry.source === "owner" && entry.line.includes("durable")));

  await second.sendOwnerLine("second attached turn");
  await waitForLeadLine(first, "lead:second attached turn");
  await waitForLeadLine(second, "lead:second attached turn");
  assert.deepEqual(second.transcript, first.transcript);
});

test("a host-side observer sees live entries but never the replayed seed", async (t) => {
  const observed: LeadHostTranscriptEntry[] = [];
  const server = await startTestHost({
    transcriptSeed: [{ source: "owner", line: "seeded history" }],
    onTranscriptEntry: (entry) => observed.push(entry),
  });
  t.after(() => server.stop());
  const client = await connectLocalLeadHost(server.address);
  await waitForLeadLine(client, `lead-ready:${server.childPid}`);

  assert(!observed.some((entry) => entry.line === "seeded history"));
  assert(
    observed.some(
      (entry) => entry.source === "lead" && entry.line === `lead-ready:${server.childPid}`,
    ),
  );
});

test("a throwing observer does not disturb the host or its clients", async (t) => {
  const server = await startTestHost({
    onTranscriptEntry: () => {
      throw new Error("observer failure");
    },
  });
  t.after(() => server.stop());
  const client = await connectLocalLeadHost(server.address);
  await waitForLeadLine(client, `lead-ready:${server.childPid}`);

  await client.sendOwnerLine("work:despite-observer");
  await waitForLeadLine(client, "lead-finished:despite-observer");
});

test("explicit stop durably records intent before closing the Lead Agent input", async () => {
  const stopIntentGate = Promise.withResolvers<void>();
  const stopIntentStarted = Promise.withResolvers<void>();
  const order: string[] = [];
  const server = await startTestHost({
    async onStopIntent() {
      order.push("stop-intent-started");
      stopIntentStarted.resolve();
      await stopIntentGate.promise;
      order.push("stop-intent-recorded");
    },
  });
  const client = await connectLocalLeadHost(server.address);
  client.onTranscriptEntry((entry) => {
    if (entry.source === "lead" && entry.line === "lead-input-closed") {
      order.push("child-input-closed");
    }
  });

  let stopped = false;
  const stopping = client.stop().then((exit) => {
    stopped = true;
    return exit;
  });
  await stopIntentStarted.promise;
  assert.equal(stopped, false);
  assert.equal(order.includes("child-input-closed"), false);

  stopIntentGate.resolve();
  const exit = await stopping;
  assert.equal(exit.kind, "explicit-stop");
  assert.deepEqual(order, [
    "stop-intent-started",
    "stop-intent-recorded",
    "child-input-closed",
  ]);
  assert.deepEqual(await server.exit, exit);
});

test("best-effort system shutdown closes the Lead Agent without inventing Owner stop intent", async () => {
  let stopIntentCalled = false;
  const server = await startTestHost({
    async onStopIntent() {
      stopIntentCalled = true;
    },
  });
  const client = await connectLocalLeadHost(server.address);
  await waitForLeadLine(client, `lead-ready:${server.childPid}`);

  const exit = await server.shutdown();

  assert.equal(exit.kind, "graceful-shutdown");
  assert.equal(stopIntentCalled, false);
  assert.deepEqual(await server.exit, exit);
});

test("Owner input is acknowledged only after the child reports its durable turn identity", async (t) => {
  const server = await startTestHost();
  t.after(() => server.stop());
  const client = await connectLocalLeadHost(server.address);
  let acknowledged = false;

  const delivery = client.sendOwnerLine("delay-durable:turn").then(() => {
    acknowledged = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(acknowledged, false);

  await delivery;
  assert.equal(acknowledged, true);
  assert(client.transcript.some((entry) => entry.source === "owner" && entry.line === "delay-durable:turn"));
});

test("non-mutating Owner input can be acknowledged as handled without a false durable turn", async (t) => {
  const server = await startTestHost();
  t.after(() => server.stop());
  const client = await connectLocalLeadHost(server.address);

  await client.sendOwnerLine("handled-only");

  assert(client.transcript.some((entry) => entry.source === "owner" && entry.line === "handled-only"));
  assert.equal(leadLines(client).includes("CMD_RIKER_OWNER_HANDLED"), false);
});

test("an unexpected child exit is surfaced distinctly from a clean stop", async (t) => {
  const server = await startTestHost();
  t.after(() => server.stop());
  const client = await connectLocalLeadHost(server.address);

  await client.sendOwnerLine("exit-unexpectedly");
  const exit = await client.exit;

  assert.equal(exit.kind, "unexpected-child-exit");
  assert.equal(exit.code, 23);
  assert.deepEqual(await server.exit, exit);
});

test("a second host cannot claim the installation singleton address", async (t) => {
  const address = testAddress();
  const first = await startTestHost({ address });
  t.after(() => first.stop());

  await assert.rejects(
    startTestHost({ address }),
    (error: unknown) => {
      assert(error instanceof Error && "code" in error);
      assert.equal((error as NodeJS.ErrnoException).code, "EADDRINUSE");
      return true;
    },
  );

  const client = await connectLocalLeadHost(address);
  await waitForLeadLine(client, `lead-ready:${first.childPid}`);
  assert.equal(leadLines(client).filter((line) => line.startsWith("lead-ready:")).length, 1);
});

test("the pipe helper is stable for an installation and separates installations", () => {
  const first = localLeadHostAddress("C:\\Users\\owner\\AppData\\Local\\CMD Riker\\versions\\1");
  assert.equal(first, localLeadHostAddress("C:\\Users\\owner\\AppData\\Local\\CMD Riker\\versions\\1"));
  assert.notEqual(
    first,
    localLeadHostAddress("C:\\Users\\owner\\AppData\\Local\\CMD Riker\\versions\\2"),
  );
  if (process.platform === "win32") assert.match(first, /^\\\\\.\\pipe\\cmd-riker-lead-[a-f0-9]{32}$/);
});

async function startTestHost(
  overrides: {
    address?: string;
    transcriptSeed?: readonly LeadHostTranscriptEntry[];
    onStopIntent?: () => Promise<void>;
    onTranscriptEntry?: (entry: LeadHostTranscriptEntry) => void;
  } = {},
): Promise<LocalLeadHostServer> {
  return startLocalLeadHost({
    address: overrides.address ?? testAddress(),
    executable: process.execPath,
    args: [echoLeadHost],
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    ownerHandledMarker: "CMD_RIKER_OWNER_HANDLED",
    ...(overrides.transcriptSeed ? { transcriptSeed: overrides.transcriptSeed } : {}),
    ...(overrides.onTranscriptEntry ? { onTranscriptEntry: overrides.onTranscriptEntry } : {}),
    onStopIntent: overrides.onStopIntent ?? (async () => {}),
  });
}

function testAddress(): string {
  return localLeadHostAddress(`C:\\cmd-riker-test-installations\\${randomUUID()}`);
}

function leadLines(client: LocalLeadHostClient): string[] {
  return client.transcript
    .filter((entry) => entry.source === "lead")
    .map((entry) => entry.line);
}

async function waitForLeadLine(client: LocalLeadHostClient, expected: string): Promise<void> {
  if (leadLines(client).includes(expected)) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for Lead Agent output: ${expected}`));
    }, 2_000);
    const unsubscribe = client.onTranscriptEntry((entry) => {
      if (entry.source !== "lead" || entry.line !== expected) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}
