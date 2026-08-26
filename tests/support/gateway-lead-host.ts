import { createInterface } from "node:readline";

const sessionView = {
  leadAvailability: "available",
  activeWorkerCount: 1,
  workers: [
    {
      number: 1,
      workerSessionId: "worker-1",
      label: "Build the integration",
      status: "running",
      cancellable: true,
    },
  ],
  items: [],
  notices: [],
};

process.stdout.write("CMD Riker | Target Project: C:\\target-project\n");
process.stdout.write("Lead available | 1 Worker running | status clear\n");
process.stdout.write(`CMD_RIKER_SESSION_JSON:${JSON.stringify(sessionView)}\n`);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const wireLine of lines) {
  const line = wireLine.startsWith("CMD_RIKER_OWNER_INPUT:")
    ? (JSON.parse(wireLine.slice("CMD_RIKER_OWNER_INPUT:".length)) as { content: string }).content
    : wireLine;
  const display = line.replaceAll("\n", " / ");
  process.stdout.write(`CMD_RIKER_OWNER_RECORDED:turn-${display}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  process.stdout.write(`CMD_RIKER_WORKER_NOTICE: Worker needs input for ${display}\n`);
  process.stdout.write(
    `CMD_RIKER_OWNER_RESPONSE:${JSON.stringify({
      source: "Lead Agent",
      content: `completed ${display}\nverified`,
    })}\n`,
  );
  process.stdout.write("Lead available | 1 Worker running | status clear\n");
  process.stdout.write(`CMD_RIKER_SESSION_JSON:${JSON.stringify(sessionView)}\n`);
}
