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
  const implementation = await readFile(join(directory, "src", "index.ts"), "utf8")
    .catch(() => "");
  process.exit(implementation === "export const answer = 42;\n" ? 0 : 1);
}

process.exit(2);

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
