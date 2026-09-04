import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { localLeadHostAddress, startLocalLeadHost } from "../src/local-host/index.ts";
import type { OwnerGatewayProtocolMessage } from "../src/owner-gateway/protocol.ts";

test("real gateway accepts follow-up and interrupt while the hosted Lead is streaming", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-interruption-"));
  const project = join(root, "project");
  const stateDirectory = join(root, "state");
  await Promise.all([mkdir(project), mkdir(stateDirectory)]);
  const firstStarted = Promise.withResolvers<void>();
  const thirdStarted = Promise.withResolvers<void>();
  let calls = 0;
  const model = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "owner-model", capabilities: ["text"], context_window: 32768, input_cost_per_million_usd: 0 }] }));
      return;
    }
    for await (const _ of request) { /* consume the model request */ }
    calls++;
    const chunk = (delta: object, finish_reason: string | null = null) => ({
      id: "interruption", object: "chat.completion.chunk", created: 1, model: "owner-model",
      choices: [{ index: 0, delta, finish_reason }],
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "" }))}\n\n`);
    if (calls === 1 || calls === 3) {
      (calls === 1 ? firstStarted : thirdStarted).resolve();
      return; // Remain streaming until the real Agent aborts its HTTP request.
    }
    response.write(`data: ${JSON.stringify(chunk({ content: "Follow-up received." }))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => model.listen(0, "127.0.0.1", done));
  const address = model.address();
  assert(address && typeof address !== "string");
  await writeFile(join(stateDirectory, "config.json"), JSON.stringify({
    targetProject: { path: project },
    modelSelection: { provider: "local-openai", model: "owner-model", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1` },
    modelPolicyRevision: "interruption-test",
  }));
  const installRoot = join(root, randomUUID());
  const host = await startLocalLeadHost({
    address: localLeadHostAddress(installRoot), executable: process.execPath,
    args: [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--state-dir", stateDirectory, "--hosted"],
    durableOwnerAckPrefix: "CMD_RIKER_OWNER_RECORDED:", ownerHandledMarker: "CMD_RIKER_OWNER_HANDLED",
    encodeOwnerInput: true, interruptibleOwnerTurns: true, ownerTurnCompletePrefix: "CMD_RIKER_OWNER_TURN_COMPLETE",
    onStopIntent: async () => {},
  });
  const gateway = spawn(process.execPath, [
    fileURLToPath(new URL("../src/owner-gateway-cli.ts", import.meta.url)),
    "--install-root", installRoot, "--project", project,
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(async () => {
    gateway.kill();
    await host.stop();
    model.closeAllConnections();
    await new Promise<void>((done) => model.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });
  const records: OwnerGatewayProtocolMessage[] = [];
  const waiters = new Set<() => void>();
  const lines = createInterface({ input: gateway.stdout });
  lines.on("line", (line) => {
    records.push(JSON.parse(line) as OwnerGatewayProtocolMessage);
    for (const notify of waiters) notify();
  });
  const waitFor = (predicate: (record: OwnerGatewayProtocolMessage) => boolean) => new Promise<OwnerGatewayProtocolMessage>((done) => {
    const check = () => {
      const record = records.find(predicate);
      if (record) { waiters.delete(check); done(record); }
    };
    waiters.add(check);
    check();
  });
  const send = (id: string, content: string) => gateway.stdin.write(`${JSON.stringify({ type: "turn", id, content })}\n`);
  await waitFor((record) => record.type === "ready");
  send("first", "Start a long turn.");
  await firstStarted.promise;
  send("follow-up", "Use the new direction.");
  const second = await waitFor((record) => record.type === "turn-result" && record.id === "follow-up");
  assert.equal(second.type === "turn-result" && second.response.content, "Follow-up received.");
  const first = await waitFor((record) => record.type === "turn-error" && record.id === "first");
  assert.match(first.type === "turn-error" ? first.message : "", /interrupted/);
  send("third", "Start another long turn.");
  await thirdStarted.promise;
  send("interrupt", "/interrupt");
  const stopped = await waitFor((record) => record.type === "turn-result" && record.id === "interrupt");
  assert.match(stopped.type === "turn-result" ? stopped.response.content : "", /Worker Sessions continue/);
  await waitFor((record) => record.type === "turn-error" && record.id === "third");
  assert.equal(calls, 3, "interrupt must not start a Model turn");
  const state = openAuthoritativeState(stateDirectory);
  try {
    const session = state.readOwnerSessions()[0]!;
    assert.deepEqual(state.readOwnerConversation(session.id)!.messages.filter((message) => message.role === "owner").map((message) => message.content), [
      "Start a long turn.", "Use the new direction.", "Start another long turn.",
    ]);
    assert.equal(state.readLeadTurnAttempts().filter((attempt) => attempt.failureKind === "aborted").length, 2);
  } finally { state.close(); }
});
