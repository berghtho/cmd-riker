import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { formatAge, renderSessionPanel, rikerOwnerExtension } from "../src/pi-owner-interface.ts";
import type { SessionViewSnapshot } from "../src/session-view/index.ts";

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
    registerShortcut() {},
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

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("the Session View panel groups Workers under their Work Item with running times", () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  const snapshot: SessionViewSnapshot = {
    leadAvailability: "available",
    activeWorkerCount: 2,
    workers: [
      {
        number: 1,
        workerSessionId: "worker-1",
        label: "Implement CSV export",
        status: "running",
        cancellable: true,
        workItemId: "item-1",
        startedAt: "2026-08-21T11:48:00.000Z",
      },
      {
        number: 2,
        workerSessionId: "worker-2",
        label: "Free-floating cleanup",
        status: "starting",
        cancellable: true,
      },
    ],
    items: [
      {
        number: 1,
        workItemId: "item-1",
        outcome: "CSV export ships with column selection",
        status: "in progress (Worker running)",
        needsOwner: false,
        since: "2026-08-21T09:00:00.000Z",
      },
      {
        number: 2,
        workItemId: "item-2",
        outcome: "Broken import needs a decision",
        status: "needs you",
        needsOwner: true,
        detail: "The importer lost its source. Next: pick a replacement.",
      },
    ],
    notices: ["One effect needs reconciliation."],
  };

  const lines = renderSessionPanel(plainTheme, snapshot, now);
  const rendered = lines.join("\n");
  assert.match(rendered, /CSV export ships with column selection\s+in progress .*seit 3 h 0 min/);
  assert.match(rendered, /running · Implement CSV export · seit 12 min/);
  assert.match(rendered, /needs you/);
  assert.match(rendered, /pick a replacement/);
  assert.match(rendered, /starting · Free-floating cleanup/);
  assert.match(rendered, /One effect needs reconciliation/);
  const itemLine = lines.findIndex((line) => line.includes("CSV export ships"));
  const workerLine = lines.findIndex((line) => line.includes("Implement CSV export"));
  assert.ok(workerLine === itemLine + 2, "the Worker renders under its Work Item and status line");
});

test("the Session View panel stays human-sized: needs-you first, running bold, done collapsed", () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  const snapshot: SessionViewSnapshot = {
    leadAvailability: "available",
    activeWorkerCount: 1,
    workers: [
      {
        number: 1,
        workerSessionId: "worker-1",
        label: "Implement CSV export",
        status: "running",
        cancellable: true,
        workItemId: "item-running",
      },
    ],
    items: [
      { number: 1, workItemId: "item-done-1", outcome: "Old delivery one", status: "done", needsOwner: false },
      { number: 2, workItemId: "item-done-2", outcome: "Old delivery two", status: "done", needsOwner: false },
      {
        number: 3,
        workItemId: "item-running",
        outcome: "CSV export ships",
        status: "in progress (Worker running)",
        needsOwner: false,
      },
      {
        number: 4,
        workItemId: "item-needs-owner",
        outcome: "Broken import needs a decision",
        status: "needs you",
        needsOwner: true,
      },
      { number: 5, workItemId: "item-idle", outcome: "Idle refactoring", status: "blocked", needsOwner: false },
    ],
    notices: [],
  };

  const lines = renderSessionPanel(plainTheme, snapshot, now);
  const rendered = lines.join("\n");
  const position = (needle: string) => lines.findIndex((line) => line.includes(needle));
  assert.ok(position("Broken import") < position("CSV export ships"), "needs-you sorts first");
  assert.ok(position("CSV export ships") < position("Idle refactoring"), "running sorts before idle");
  assert.doesNotMatch(rendered, /Old delivery/);
  assert.match(rendered, /2 erledigt · Details mit \/items/);
});

test("panel ages read plainly at every magnitude", () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  assert.equal(formatAge("2026-08-21T11:59:40.000Z", now), "unter 1 min");
  assert.equal(formatAge("2026-08-21T11:15:00.000Z", now), "45 min");
  assert.equal(formatAge("2026-08-21T09:30:00.000Z", now), "2 h 30 min");
  assert.equal(formatAge("2026-08-19T10:00:00.000Z", now), "2 d 2 h");
  assert.equal(formatAge("invalid", now), "");
});
