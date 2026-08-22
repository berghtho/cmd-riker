import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWindowsToastNotifier,
  ownerToastAppUserModelId,
  ownerToastDisplayName,
  ownerToastRegistryKey,
  ownerToastShortcutPath,
} from "../src/owner-notifications/index.ts";

type RecordedCommand = { executable: string; args: readonly string[] };

function recordingNotifier(appDataDirectory: string) {
  const commands: RecordedCommand[] = [];
  const notifier = createWindowsToastNotifier({
    snoretoastPath: "C:\\bundle\\tools\\snoretoast\\snoretoast-x64.exe",
    appDataDirectory,
    runCommand: async (executable, args) => {
      commands.push({ executable, args });
    },
  });
  return { notifier, commands };
}

async function appDataFixture(t: test.TestContext): Promise<string> {
  const appData = await mkdtemp(join(tmpdir(), "cmd-riker-toast-"));
  t.after(() => rm(appData, { recursive: true, force: true }));
  return appData;
}

test("registration writes the per-user registry identity, never a Start Menu shortcut", async (t) => {
  const appData = await appDataFixture(t);
  const { notifier, commands } = recordingNotifier(appData);

  await notifier.ensureRegistered();

  assert.deepEqual(commands, [
    {
      executable: "reg.exe",
      args: [
        "add",
        ownerToastRegistryKey,
        "/v",
        "DisplayName",
        "/t",
        "REG_SZ",
        "/d",
        ownerToastDisplayName,
        "/f",
      ],
    },
  ]);
  const shortcut = ownerToastShortcutPath(appData);
  assert(shortcut !== undefined);
  assert.equal(existsSync(shortcut), false);
});

test("registration removes the legacy Start Menu shortcut", async (t) => {
  const appData = await appDataFixture(t);
  const shortcut = ownerToastShortcutPath(appData);
  assert(shortcut !== undefined);
  await mkdir(join(appData, "Microsoft", "Windows", "Start Menu", "Programs"), {
    recursive: true,
  });
  await writeFile(shortcut, "legacy shortcut");
  const { notifier } = recordingNotifier(appData);

  await notifier.ensureRegistered();

  assert.equal(existsSync(shortcut), false);
});

test("a notice becomes one branded toast under the registered identity", async (t) => {
  const appData = await appDataFixture(t);
  const { notifier, commands } = recordingNotifier(appData);

  notifier.notify({ title: "CMD Riker", message: "Worker (objective) needs you: question" });
  await Promise.resolve();

  assert.deepEqual(commands, [
    {
      executable: "C:\\bundle\\tools\\snoretoast\\snoretoast-x64.exe",
      args: [
        "-t",
        "CMD Riker",
        "-m",
        "Worker (objective) needs you: question",
        "-appID",
        ownerToastAppUserModelId,
        "-silent",
      ],
    },
  ]);
});

test("long notices are truncated instead of overflowing the toast", async (t) => {
  const appData = await appDataFixture(t);
  const { notifier, commands } = recordingNotifier(appData);

  notifier.notify({ title: "CMD Riker", message: "x".repeat(500) });
  await Promise.resolve();

  const message = commands[0]?.args[3];
  assert(typeof message === "string");
  assert.equal(message.length, 200);
  assert(message.endsWith("…"));
});

test("a failing toast command never reaches the caller", async (t) => {
  const appData = await appDataFixture(t);
  const notifier = createWindowsToastNotifier({
    snoretoastPath: "C:\\bundle\\tools\\snoretoast\\snoretoast-x64.exe",
    appDataDirectory: appData,
    runCommand: () => Promise.reject(new Error("spawn failed")),
  });

  notifier.notify({ title: "CMD Riker", message: "notice" });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
});
