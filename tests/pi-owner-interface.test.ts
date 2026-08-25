import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionRunner,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEvent,
  type InputEventResult,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

import {
  formatAge,
  renderDecisionDock,
  renderOperationsPanel,
  renderSessionNavigation,
} from "../src/owner-surface/index.ts";
import { rikerOwnerExtension } from "../src/pi-owner-interface.ts";
import type { SessionViewSnapshot } from "../src/session-view/index.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("Pi Owner interface handles one Riker turn in-process", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const messages: Array<{ customType: string; content: unknown; display?: boolean }> = [];
  const ownerInputs: string[] = [];
  const pi = shellApi(handlers, messages);
  const extension = rikerOwnerExtension({
    targetProjectPath: "C:\\target-project",
    transcript: [],
    async completeOwnerInput(ownerInput) {
      ownerInputs.push(ownerInput);
      return { source: "Lead Agent", content: "Ein Fenster" };
    },
    readSessionView: () => "Lead available | 0 Worker Sessions | no attention",
  });

  if (typeof extension === "function") throw new Error("Expected a named inline extension.");
  await extension.factory(pi);
  const handleInput = handlers.get("input");
  assert.ok(handleInput);
  const result = await handleInput(
    { type: "input", source: "interactive", text: "Arbeite hier." } as InputEvent,
    { ui: { notify() {}, setTitle() {} } } as unknown as ExtensionContext,
  ) as InputEventResult;

  assert.deepEqual(result, { action: "handled" });
  assert.deepEqual(ownerInputs, ["Arbeite hier."]);
  assert.deepEqual(messages, [
    { customType: "riker-owner", content: "Arbeite hier.", display: true },
    { customType: "riker-lead", content: "Ein Fenster", display: true },
  ]);
});

test("Pi Owner interface restarts when the current Owner Session conversation is replaced", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let replacement: (() => void) | undefined;
  let shutdowns = 0;
  const pi = shellApi(handlers, []);
  const extension = rikerOwnerExtension({
    targetProjectPath: "C:\\target-project",
    transcript: [],
    async completeOwnerInput() {
      return { source: "Lead Agent", content: "unused" };
    },
    readSessionView() {
      return "Lead available | 0 Workers | all quiet";
    },
    subscribeConversationReplacements(listener) {
      replacement = listener;
      return () => { replacement = undefined; };
    },
  });
  if (typeof extension === "function") throw new Error("Expected a named inline extension.");
  await extension.factory(pi);
  const context = {
    shutdown() {
      shutdowns += 1;
    },
    ui: {
      setTitle() {},
      setHeader() {},
      setFooter() {},
      setWidget() {},
      setWorkingMessage() {},
    },
  } as unknown as ExtensionContext;

  await handlers.get("session_start")?.({}, context);
  replacement?.();
  assert.equal(shutdowns, 1);
  await handlers.get("session_shutdown")?.({}, context);
  assert.equal(replacement, undefined);
});

test("Pi installs one bounded non-overlay OwnerSurface with stable shortcuts", async (t) => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const shortcuts = new Map<KeyId, { handler: (ctx: ExtensionContext) => unknown }>();
  const widgets: Array<{ key: string; content: unknown; options: unknown }> = [];
  const pi = shellApi(handlers, [], shortcuts);
  const extension = rikerOwnerExtension({
    targetProjectPath: "C:\\target-project",
    transcript: [],
    async completeOwnerInput() {
      return { source: "Lead Agent", content: "Done" };
    },
    readSessionView: () => "Lead available | 0 Worker Sessions | no attention",
    readSessionData: sessionSnapshot,
  });
  if (typeof extension === "function") throw new Error("Expected a named inline extension.");
  await extension.factory(pi);
  const shutdown = handlers.get("session_shutdown");
  t.after(() => shutdown?.());

  let customUiCalls = 0;
  const context = {
    ui: {
      setTitle() {},
      setHeader() {},
      setFooter() {},
      setWidget(key: string, content: unknown, options: unknown) {
        widgets.push({ key, content, options });
      },
      setWorkingMessage() {},
      custom() {
        customUiCalls += 1;
        return Promise.resolve();
      },
    },
  } as unknown as ExtensionContext;
  handlers.get("session_start")?.({}, context);

  assert.deepEqual(widgets.map(({ key, options }) => ({ key, options })), [
    { key: "riker-owner-surface", options: { placement: "aboveEditor" } },
  ]);
  const factory = widgets[0]?.content;
  assert.equal(typeof factory, "function");
  const widget = (factory as (
    tui: { requestRender(): void },
    theme: Theme,
  ) => { render(width: number): string[] })({ requestRender() {} }, plainTheme);
  assert.deepEqual(widget.render(60), []);

  await shortcuts.get("alt+a")?.handler(context);
  const activity = widget.render(60);
  assert.match(activity.join("\n"), /Aktivität/);
  assert.ok(activity.length <= 8);
  await shortcuts.get("shift+left")?.handler(context);
  assert.match(widget.render(60).join("\n"), /Session-Navigation.*Aktuelle Session/s);
  await shortcuts.get("shift+right")?.handler(context);
  assert.deepEqual(widget.render(60), []);

  const runner = new ExtensionRunner(
    [{
      shortcuts: new Map([...shortcuts.keys()].map((shortcut) => [shortcut, {
        shortcut,
        extensionPath: "riker",
        description: "OwnerSurface",
        async handler() {},
      }])),
    } as never],
    {} as never,
    ".",
    {} as never,
    {} as never,
  );
  const resolved = runner.getShortcuts({ "tui.editor.deleteToLineEnd": "ctrl+k" } as never);
  assert.deepEqual([...resolved.keys()].sort(), ["alt+a", "shift+left", "shift+right"]);
  assert.equal(customUiCalls, 0);
  assert.equal(shortcuts.has("ctrl+shift+k"), false);
});

test("a direct session switch requests a clean Pi restart", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const messages: Array<{ customType: string; content: unknown; display?: boolean }> = [];
  const replacement = { requested: false };
  const pi = shellApi(handlers, messages);
  const extension = rikerOwnerExtension({
    targetProjectPath: "C:\\old",
    transcript: [],
    async completeOwnerInput() {
      return {
        source: "Lead Agent",
        content: "Switched.",
        reattach: true,
      };
    },
    readSessionView: () => "available",
  }, replacement);
  if (typeof extension === "function") throw new Error("Expected a named inline extension.");
  await extension.factory(pi);
  let shutdowns = 0;
  await handlers.get("input")?.(
    { type: "input", source: "interactive", text: "/session use 2" } as InputEvent,
    {
      ui: { notify() {}, setTitle() {} },
      shutdown() { shutdowns += 1; },
    } as unknown as ExtensionContext,
  );
  assert.equal(shutdowns, 1);
  assert.equal(replacement.requested, true);
});

test("Activity stays human-sized and does not expose private IDs", () => {
  const rendered = renderOperationsPanel(plainTheme, sessionSnapshot(), Date.parse("2026-08-21T12:00:00Z"), 60).join("\n");
  assert.match(rendered, /Aktivität/);
  assert.match(rendered, /Aktuelle Arbeit/);
  assert.doesNotMatch(rendered, /private-id/);
});

test("decision dock appears only for a real Owner decision", () => {
  const snapshot = sessionSnapshot();
  snapshot.items.push({
    number: 2,
    workItemId: "item-private-id",
    outcome: "Choose a replacement import source",
    status: "needs you",
    needsOwner: true,
    detail: "The importer lost its source. Next: Pick the latest verified export.",
  });
  const rendered = renderDecisionDock(plainTheme, snapshot).join("\n");
  assert.match(rendered, /Deine Entscheidung/);
  assert.match(rendered, /Empfehlung: Pick the latest verified export/);
  assert.doesNotMatch(rendered, /item-private-id/);
  assert.deepEqual(renderDecisionDock(plainTheme, { ...snapshot, items: [] }), []);
});

test("session navigation shows the current context and switch commands", () => {
  const rendered = renderSessionNavigation(plainTheme, sessionSnapshot()).join("\n");
  assert.match(rendered, /Session-Navigation/);
  assert.match(rendered, /● \[riker\] Aktuelle Session/);
  assert.match(rendered, /\/session use 2/);
  assert.match(rendered, /2 Projekte/);
});

test("ages read plainly at every magnitude", () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  assert.equal(formatAge("2026-08-21T11:59:40.000Z", now), "unter 1 min");
  assert.equal(formatAge("2026-08-21T11:15:00.000Z", now), "45 min");
  assert.equal(formatAge("2026-08-21T09:30:00.000Z", now), "2 h 30 min");
  assert.equal(formatAge("2026-08-19T10:00:00.000Z", now), "2 d 2 h");
  assert.equal(formatAge("invalid", now), "");
});

function shellApi(
  handlers: Map<string, (...args: unknown[]) => unknown>,
  messages: Array<{ customType: string; content: unknown; display?: boolean }>,
  shortcuts?: Map<KeyId, { handler: (ctx: ExtensionContext) => unknown }>,
): ExtensionAPI {
  return {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    registerMessageRenderer() {},
    registerCommand() {},
    registerShortcut(shortcut: KeyId, options: { handler: (ctx: ExtensionContext) => unknown }) {
      shortcuts?.set(shortcut, options);
    },
    sendMessage(message: { customType: string; content: unknown; display?: boolean }) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
}

function sessionSnapshot(): SessionViewSnapshot {
  return {
    leadAvailability: "available",
    activeWorkerCount: 1,
    workers: [{
      number: 1,
      workerSessionId: "worker-private-id",
      label: "Aktuelle Arbeit",
      status: "running",
      cancellable: true,
      workItemId: "item-active",
    }],
    items: [{
      number: 1,
      workItemId: "item-active",
      outcome: "Aktuelle Arbeit",
      status: "in progress (Worker running)",
      needsOwner: false,
    }],
    notices: [],
    sessions: [
      {
        number: 1,
        sessionId: "session-current",
        name: "Aktuelle Session",
        current: true,
        lastActiveAt: "2026-08-21T12:00:00Z",
        state: "active",
        project: "riker",
      },
      {
        number: 2,
        sessionId: "session-other",
        name: "Andere Session",
        current: false,
        lastActiveAt: "2026-08-21T11:00:00Z",
        state: "active",
        project: "survivors",
      },
    ],
    projects: [
      { number: 1, name: "riker", path: "C:\\riker", sessionCount: 1 },
      { number: 2, name: "survivors", path: "C:\\survivors", sessionCount: 1 },
    ],
  };
}
