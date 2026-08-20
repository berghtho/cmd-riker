import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import { rikerOwnerExtension } from "../src/pi-owner-interface.ts";

test("Pi Owner interface handles one Riker turn in-process", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const messages: Array<{ customType: string; content: unknown; display?: boolean }> = [];
  const ownerInputs: string[] = [];
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    registerMessageRenderer() {},
    registerCommand() {},
    sendMessage(message: { customType: string; content: unknown; display?: boolean }) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  const extension = rikerOwnerExtension({
    targetProjectPath: "C:\\target-project",
    transcript: [],
    async completeOwnerInput(ownerInput) {
      ownerInputs.push(ownerInput);
      return { source: "Lead Agent", content: "Ein Fenster" };
    },
    readSessionView() {
      return "Lead available | 0 Worker Sessions | no attention";
    },
  });

  assert.equal(typeof extension, "object");
  if (typeof extension === "function") throw new Error("Expected a named inline extension.");
  await extension.factory(pi);
  const handleInput = handlers.get("input");
  assert.ok(handleInput);

  const result = await handleInput(
    {
      type: "input",
      source: "interactive",
      text: "Arbeite hier.",
    } as InputEvent,
    { ui: { notify() {} } } as unknown as ExtensionContext,
  ) as InputEventResult;

  assert.deepEqual(result, { action: "handled" });
  assert.deepEqual(ownerInputs, ["Arbeite hier."]);
  assert.deepEqual(messages, [
    { customType: "riker-owner", content: "Arbeite hier.", display: true },
    { customType: "riker-lead", content: "Ein Fenster", display: true },
  ]);
});
