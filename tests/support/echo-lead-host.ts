import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

process.stdout.write(`lead-ready:${process.pid}\n`);

for await (const line of lines) {
  if (line.startsWith("delay-durable:")) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  process.stdout.write(
    line === "handled-only"
      ? "CMD_RIKER_OWNER_HANDLED\n"
      : `CMD_RIKER_OWNER_RECORDED:${line}\n`,
  );
  if (line === "exit-unexpectedly") {
    process.stderr.write("lead-failed\n", () => process.exit(23));
    break;
  }
  if (line.startsWith("work:")) {
    const work = line.slice("work:".length);
    process.stdout.write(`lead-started:${work}\n`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    process.stdout.write(`lead-finished:${work}\n`);
    continue;
  }
  process.stdout.write(`lead:${line}\n`);
}

process.stdout.write("lead-input-closed\n");
