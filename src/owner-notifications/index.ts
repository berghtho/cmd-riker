import { execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export const ownerToastAppUserModelId = "CMDRiker.Lead";
export const ownerToastDisplayName = "CMD Riker";
export const ownerToastRegistryKey =
  `HKCU\\Software\\Classes\\AppUserModelId\\${ownerToastAppUserModelId}`;

// Windows resolves a toast's display name from the sender's AppUserModelID.
// That identity is registered per-user in the registry - never as a Start Menu
// shortcut: a .lnk pointing into AppData is exactly the pattern antivirus
// heuristics flag as a loader.
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
    `${ownerToastDisplayName}.lnk`,
  );
}

export async function removeOwnerToastRegistration(appDataDirectory?: string): Promise<void> {
  const shortcut = ownerToastShortcutPath(appDataDirectory);
  if (shortcut) await rm(shortcut, { force: true });
  await runRegistryCommand(["delete", ownerToastRegistryKey, "/f"]).catch(() => {
    // A missing key is the desired end state.
  });
}

export type WindowsToastNotifier = {
  ensureRegistered(): Promise<void>;
  notify(input: { title: string; message: string }): void;
};

export type WindowsToastNotifierOptions = {
  snoretoastPath: string;
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
      await runCommand("reg.exe", [
        "add",
        ownerToastRegistryKey,
        "/v",
        "DisplayName",
        "/t",
        "REG_SZ",
        "/d",
        ownerToastDisplayName,
        "/f",
      ]);
      // Earlier versions registered the identity through a Start Menu shortcut;
      // migrate it away so antivirus heuristics stop tripping over the .lnk.
      const legacyShortcut = ownerToastShortcutPath(options.appDataDirectory);
      if (legacyShortcut) await rm(legacyShortcut, { force: true });
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

function runRegistryCommand(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile("reg.exe", [...args], { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

// SnoreToast exits non-zero for dismissed or timed-out toasts; that is a
// delivered notification, not a failure, so only spawning itself can fail.
function runToastCommand(executable: string, args: readonly string[]): Promise<void> {
  if (executable.toLowerCase() === "reg.exe") return runRegistryCommand(args);
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
