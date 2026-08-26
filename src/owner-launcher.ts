import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const installRoot = resolve(requiredArgument("--install-root"));
const forwarded = process.argv.slice(2).filter((value, index, values) =>
  value !== "--install-root" && values[index - 1] !== "--install-root"
);
const command = forwarded[0] ?? "start";
const commandArguments = forwarded.slice(1);

try {
  const installation = await readInstallation(installRoot);
  if (command === "start" || command === "gateway") {
    await run(installation.leadAgent.runtimePath, [
      installation.leadAgent.lifecyclePath,
      "start",
      "--install-root",
      installRoot,
    ], "ignore", true);
    const ownerEntrypoint = command === "gateway"
      ? installation.leadAgent.ownerGatewayPath ??
        join(installation.leadAgent.path, "dist", "owner-gateway-cli.js")
      : installation.leadAgent.ownerClientPath ??
        join(installation.leadAgent.path, "dist", "owner-client.js");
    await run(installation.leadAgent.runtimePath, [
      ownerEntrypoint,
      "--install-root",
      installRoot,
    ], "inherit", false);
  } else {
    await run(installation.leadAgent.runtimePath, [
      installation.leadAgent.lifecyclePath,
      command,
      "--install-root",
      installRoot,
      ...commandArguments,
    ], "inherit", false);
  }
} catch (error) {
  process.stderr.write(
    `CMD_RIKER_LAUNCH_FAILURE: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}

type InstallationManifest = {
  leadAgent: {
    path: string;
    runtimePath: string;
    lifecyclePath: string;
    ownerClientPath?: string;
    ownerGatewayPath?: string;
  };
};

async function readInstallation(installationRoot: string): Promise<InstallationManifest> {
  const value = JSON.parse(
    await readFile(join(installationRoot, "launcher", "installation.json"), "utf8"),
  ) as Partial<InstallationManifest>;
  if (
    typeof value.leadAgent?.path !== "string" ||
    typeof value.leadAgent.runtimePath !== "string" ||
    typeof value.leadAgent.lifecyclePath !== "string"
  ) {
    throw new Error("The installed launcher manifest is incomplete.");
  }
  return value as InstallationManifest;
}

async function run(
  executable: string,
  args: string[],
  stdio: "ignore" | "inherit",
  windowsHide: boolean,
): Promise<void> {
  const child = spawn(executable, args, { shell: false, stdio, windowsHide });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolvePromise({ code, signal }));
    },
  );
  if (exit.code !== 0) {
    throw new Error(
      `Command exited with code ${exit.code ?? "none"} and signal ${exit.signal ?? "none"}.`,
    );
  }
}

function requiredArgument(name: string): string {
  const index = process.argv.lastIndexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
