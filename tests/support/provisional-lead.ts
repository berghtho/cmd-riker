import { createInterface } from "node:readline";

const value = (name: string): string => {
  const index = process.argv.indexOf(name);
  const result = index >= 0 ? process.argv[index + 1] : undefined;
  if (!result) throw new Error(`${name} is required.`);
  return result;
};

process.stdout.write(`${JSON.stringify({
  type: "CMD_RIKER_ACTIVATION_READY",
  attemptId: value("--activation-attempt-id"),
  candidateRevision: value("--candidate-revision"),
  artifactDigest: value("--artifact-digest"),
  handshakeNonce: value("--activation-handshake-nonce"),
  pid: process.pid,
})}\n`);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const _line of lines) {
  // The production adapter only needs a live provisional process during external health checks.
}
