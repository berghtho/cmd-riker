import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("Task version: v3.53.1\n");
  process.exit(0);
}

const directory = argumentValue("--dir");
if (!directory) process.exit(2);

if (process.argv.includes("--list-all") && process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify({
    location: join(resolve(directory), "Taskfile.yml"),
    tasks: [{ name: "test" }],
  }));
  process.exit(0);
}

if (process.argv.at(-1) === "test") {
  const taskfile = argumentValue("--taskfile");
  const declaration = taskfile ? await readFile(taskfile, "utf8").catch(() => "") : "";
  if (!/node --test index\.test\.mjs/.test(declaration)) process.exit(2);
  const child = spawn(process.execPath, ["--test", "index.test.mjs"], {
    cwd: directory,
    stdio: "ignore",
    windowsHide: true,
  });
  process.exit(await new Promise<number>((resolveExit) => {
    child.on("error", () => resolveExit(2));
    child.on("close", (code) => resolveExit(code ?? 2));
  }));
}

process.exit(2);

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
