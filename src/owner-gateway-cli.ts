import { resolve } from "node:path";

import { localLeadHostAddress } from "./local-host/index.ts";
import { connectOwnerGateway } from "./owner-gateway/index.ts";
import { runOwnerGatewayProtocol } from "./owner-gateway/protocol.ts";

const installRoot = resolve(requiredArgument("--install-root"));

try {
  const gateway = await connectWithRetry(localLeadHostAddress(installRoot), 10_000);
  await runOwnerGatewayProtocol(gateway, process.stdin, process.stdout);
} catch (error) {
  process.stderr.write(
    `CMD_RIKER_OWNER_GATEWAY_FAILURE: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}

async function connectWithRetry(
  address: string,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof connectOwnerGateway>>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectOwnerGateway(address);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error("Timed out waiting for the protected Lead Agent.", { cause: lastError });
}

function requiredArgument(name: string): string {
  const index = process.argv.lastIndexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
