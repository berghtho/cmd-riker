import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export const ownerToastAppUserModelId = "CMDRiker.Lead";
export const ownerToastShortcutName = "CMD Riker";

// Windows resolves a toast's display name and icon from a Start Menu shortcut
// carrying the AppUserModelID; without one the toast is labeled with the raw
// sending executable, which is exactly what the Owner must never see.
export function ownerToastShortcutPath(
  appDataDirectory: string | undefined = process.env.APPDATA,
): string | undefined {
  if (!appDataDirectory) return undefined;
  return join(
    appDataDirectory,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    `${ownerToastShortcutName}.lnk`,
  );
}

export async function removeOwnerToastRegistration(appDataDirectory?: string): Promise<void> {
  const shortcut = ownerToastShortcutPath(appDataDirectory);
  if (!shortcut) return;
  await rm(shortcut, { force: true });
}

export type WindowsToastNotifier = {
  ensureRegistered(): Promise<void>;
  notify(input: { title: string; message: string }): void;
};

export type WindowsToastNotifierOptions = {
  snoretoastPath: string;
  /** Launched when the Owner opens the Start Menu shortcut that carries the toast identity. */
  shortcutTarget: string;
  appDataDirectory?: string;
  // Toast delivery is observable side effect only; tests inject a recorder.
  runCommand?: (executable: string, args: readonly string[]) => Promise<void>;
};

const toastMessageLimit = 200;

export function createWindowsToastNotifier(
  options: WindowsToastNotifierOptions,
): WindowsToastNotifier {
  const runCommand = options.runCommand ?? runToastCommand;
  return {
    async ensureRegistered() {
      const shortcut = ownerToastShortcutPath(options.appDataDirectory);
      if (shortcut !== undefined && existsSync(shortcut)) return;
      await runCommand(options.snoretoastPath, [
        "-install",
        ownerToastShortcutName,
        options.shortcutTarget,
        ownerToastAppUserModelId,
      ]);
    },
    notify(input) {
      const message =
        input.message.length > toastMessageLimit
          ? `${input.message.slice(0, toastMessageLimit - 1)}…`
          : input.message;
      void runCommand(options.snoretoastPath, [
        "-t",
        input.title,
        "-m",
        message,
        "-appID",
        ownerToastAppUserModelId,
        "-silent",
      ]).catch(() => {
        // Toasts are best-effort; the durable state already carries the fact.
      });
    },
  };
}

// SnoreToast exits non-zero for dismissed or timed-out toasts; that is a
// delivered notification, not a failure, so only spawning itself can fail.
function runToastCommand(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], { stdio: "ignore", windowsHide: true });
    } catch {
      resolvePromise();
      return;
    }
    child.once("error", () => resolvePromise());
    child.once("close", () => resolvePromise());
  });
}
