import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  connectLocalLeadHost,
  localLeadHostAddress,
  startLocalLeadHost,
  type LeadHostTranscriptEntry,
  type LocalLeadHostClient,
  type LocalLeadHostServer,
} from "../src/local-host/index.ts";

const echoLeadHost = new URL("./support/echo-lead-host.ts", import.meta.url)
  .pathname.replace(/^\/(.:)/, "$1");

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
  } = {},
): Promise<LocalLeadHostServer> {
  return startLocalLeadHost({
    address: overrides.address ?? testAddress(),
    executable: process.execPath,
    args: [echoLeadHost],
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:",
    ownerHandledMarker: "CMD_RIKER_OWNER_HANDLED",
    ...(overrides.transcriptSeed ? { transcriptSeed: overrides.transcriptSeed } : {}),
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
