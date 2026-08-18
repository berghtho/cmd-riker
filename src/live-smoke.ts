import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const stateDirectory = argumentValue("--state-dir");
if (!stateDirectory) {
  process.stderr.write(
    "CMD_RIKER_SMOKE_USAGE: Run with --state-dir pointing to a configured local smoke state directory.\n",
  );
  process.exitCode = 2;
} else {
  const prompt =
    argumentValue("--prompt") ?? "Reply with exactly: CMD Riker live smoke passed.";
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const child = spawn(process.execPath, [cliPath, "--state-dir", stateDirectory], {
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  child.stdin.end(`${prompt}\n`);
  process.exitCode = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(2));
    child.on("close", (code) => resolve(code ?? 2));
  });
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
