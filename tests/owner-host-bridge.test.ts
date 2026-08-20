import assert from "node:assert/strict";
import test from "node:test";

import { completeHostedOwnerInput } from "../src/owner-host-bridge.ts";
import type { LeadHostExit, LeadHostTranscriptEntry } from "../src/local-host/index.ts";

test("host shutdown during an Owner write rejects the turn without an unhandled rejection", async () => {
  let transcriptHandler: ((entry: LeadHostTranscriptEntry) => void) | undefined;
  let exitHandler: ((exit: LeadHostExit) => void) | undefined;
  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", recordUnhandled);

  try {
    const completion = completeHostedOwnerInput({
      transcript: [],
      onTranscriptEntry(handler) {
        transcriptHandler = handler;
        return () => { transcriptHandler = undefined; };
      },
      onExit(handler) {
        exitHandler = handler;
        return () => { exitHandler = undefined; };
      },
      async sendOwnerLine() {
        exitHandler?.({ kind: "graceful-shutdown", code: 0, signal: null });
        await new Promise((resolve) => setImmediate(resolve));
      },
    }, "continue");

    await assert.rejects(completion, /stopped unexpectedly \(graceful-shutdown\)/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(transcriptHandler, undefined);
    assert.equal(exitHandler, undefined);
  } finally {
    process.off("unhandledRejection", recordUnhandled);
  }
});
