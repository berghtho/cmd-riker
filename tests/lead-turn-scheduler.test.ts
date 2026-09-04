import assert from "node:assert/strict";
import test from "node:test";
import { createLeadTurnScheduler } from "../src/lead-turn-scheduler/index.ts";

test("Owner input interrupts autonomous inference and waits for its effects to settle", async () => {
  const started = Promise.withResolvers<void>();
  const finishEffect = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const order: string[] = [];
  let offered = false;
  const scheduler = createLeadTurnScheduler({
    nextContinuation() {
      if (offered) return undefined;
      offered = true;
      return {
        scope: { targetProjectPath: "C:\\project-a", sessionId: "session-a" },
        async run(signal: AbortSignal) {
          signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          order.push("autonomous-start");
          started.resolve();
          await finishEffect.promise;
          order.push("autonomous-settled");
        },
      };
    },
    onError: (error) => { throw error; },
  });
  scheduler.wake();
  await started.promise;
  const owner = scheduler.submitOwner({ targetProjectPath: "C:\\project-b" }, async () => {
    order.push("owner");
  });
  await aborted.promise;
  assert.deepEqual(order, ["autonomous-start"]);
  finishEffect.resolve();
  await owner;
  assert.deepEqual(order, ["autonomous-start", "autonomous-settled", "owner"]);
  await scheduler.close();
});

test("a scoped interruption cannot cancel another project or a replacement turn", async () => {
  const started = Promise.withResolvers<void>();
  const scheduler = createLeadTurnScheduler({ nextContinuation: () => undefined, onError: () => {} });
  let signal: AbortSignal | undefined;
  const owner = scheduler.submitOwner(
    { targetProjectPath: "C:\\project-a", sessionId: "session-a", ownerTurnId: "new-turn" },
    async (activeSignal) => {
      signal = activeSignal;
      started.resolve();
      await new Promise<void>((done) => activeSignal.addEventListener("abort", () => done(), { once: true }));
    },
  );
  await started.promise;
  assert.equal(scheduler.interrupt({ targetProjectPath: "C:\\project-b" }), false);
  assert.equal(scheduler.interrupt({ targetProjectPath: "C:\\project-a", sessionId: "different" }), false);
  assert.equal(scheduler.interrupt({ targetProjectPath: "C:\\project-a", ownerTurnId: "old-turn" }), false);
  assert.equal(signal?.aborted, false);
  assert.equal(scheduler.interrupt({ targetProjectPath: "C:\\project-a", ownerTurnId: "new-turn" }), true);
  await owner;
  await scheduler.close();
});

test("shutdown rejects queued Owner work without starting its effects", async () => {
  const started = Promise.withResolvers<void>();
  const scheduler = createLeadTurnScheduler({ nextContinuation: () => undefined, onError: () => {} });
  const first = scheduler.submitOwner({ targetProjectPath: "C:\\project" }, async (signal) => {
    started.resolve();
    await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
  });
  await started.promise;
  let ran = false;
  const second = scheduler.submitOwner({ targetProjectPath: "C:\\project" }, async () => { ran = true; });
  const rejected = assert.rejects(second, /closed before/);
  await scheduler.close();
  await Promise.all([first, rejected]);
  assert.equal(ran, false);
});
