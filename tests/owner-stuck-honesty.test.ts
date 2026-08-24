import assert from "node:assert/strict";
import test from "node:test";

import { PiAgentTurnAdapter } from "../src/conversation-runtime/index.ts";
import { commitmentNotice } from "../src/lead-agent-runtime/index.ts";
import { startLocalModel } from "./support/local-model.ts";

test("a Work Item blocked on the Owner is announced as needing them, with the next action", () => {
  assert.equal(
    commitmentNotice({
      id: "commitment-1",
      outcome: "The requested change ships.",
      state: "active",
      condition: {
        kind: "blocked",
        nextAction: "Approve the repaired Forge configuration.",
        ownerAttention: "owner-reserved-decision",
      },
    }),
    "Work item needs you: The requested change ships. " +
      "Next: Approve the repaired Forge configuration.",
  );
});

test("a blocked Work Item names its next action instead of a bare state", () => {
  assert.equal(
    commitmentNotice({
      id: "commitment-2",
      outcome: "The label is removed.",
      state: "active",
      condition: { kind: "blocked", nextAction: "Diagnose the rejected operation." },
    }),
    "Work item blocked: The label is removed. Next: Diagnose the rejected operation.",
  );
});

test("a delivered Work Item notice stays unchanged", () => {
  assert.equal(
    commitmentNotice({
      id: "commitment-3",
      outcome: "The requested change ships.",
      state: "accepted",
    }),
    "Work item delivered: The requested change ships.",
  );
});

test("the Lead system prompt forbids hiding a stuck state behind reassurance or substitute activity", async (t) => {
  let firstRequest = "";
  const localModel = await startLocalModel((_call, requestBody) => {
    firstRequest ||= JSON.stringify(requestBody);
    return "Standing by with a clear ask.";
  });
  t.after(() => localModel.close());

  await new PiAgentTurnAdapter().completeTurn({
    conversation: [],
    ownerInput: "status?",
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: localModel.baseUrl,
    },
  });

  assert.match(firstRequest, /Never tell the Owner they need to do nothing/);
  assert.match(firstRequest, /never start substitute activity/);
  assert.match(firstRequest, /repairing or updating CMD Riker itself/);
  assert.match(firstRequest, /language the Owner writes to you/);
  assert.match(firstRequest, /Never paste Worker or tool output verbatim/);
});
