import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { localLeadHostAddress } from "./local-host/index.ts";
import { inspectLocalSourceCheckout } from "./local-source-checkout/index.ts";
import {
  runPiOwnerInterface,
  type PiOwnerUpdateStatus,
} from "./pi-owner-interface.ts";
import { connectOwnerGateway } from "./owner-gateway/index.ts";
import { renderSessionView } from "./session-view/index.ts";

const installRoot = requiredArgument("--install-root");

try {
  await runOwnerClient(installRoot);
} catch (error) {
  process.stderr.write(
    `CMD_RIKER_OWNER_INTERFACE_FAILURE: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}

async function runOwnerClient(installationRoot: string): Promise<void> {
  const gateway = await connectOwnerGateway(
    localLeadHostAddress(resolve(installationRoot)),
    { connectTimeoutMs: 10_000 },
  );
  try {
    const readUpdateStatus = createUpdateStatusReader(resolve(installationRoot));
    let outcome: Awaited<ReturnType<typeof runPiOwnerInterface>>;
    do {
      outcome = await runPiOwnerInterface({
        targetProjectPath: gateway.snapshot.targetProjectPath,
        transcript: gateway.snapshot.conversation,
        completeOwnerInput: (ownerInput) => gateway.completeTurn(ownerInput),
        readSessionView: () => gateway.snapshot.sessionView
          ? renderSessionView(gateway.snapshot.sessionView)
          : "Lead starting | Worker Sessions unavailable | status pending",
        readSessionData: () => gateway.snapshot.sessionView,
        readUpdateStatus,
        subscribeNotices: (listener) => gateway.subscribe((event) => {
          if (event.type === "notice") listener(event.content);
        }),
        subscribeConversationReplacements: (listener) => {
          return gateway.subscribe((event) => {
            if (event.type === "conversation" && event.replaced) listener();
          });
        },
      });
    } while (outcome === "conversation-replaced");
  } finally {
    await gateway.detach();
  }
}

// The installed bundle records its source commit. When the Owner launches from
// the matching checkout, the client polls that checkout's HEAD in the
// background. Checkout paths are never persisted; Git failures, another
// checkout, or a missing source record simply disable the notice.
function createUpdateStatusReader(
  installationRoot: string,
): () => PiOwnerUpdateStatus | undefined {
  let status: PiOwnerUpdateStatus | undefined;
  let source: { commit: string; revision: string } | undefined;
  try {
    const launcher = JSON.parse(
      readFileSync(join(installationRoot, "launcher", "installation.json"), "utf8"),
    ) as { leadAgent?: { path?: string; identity?: { revision?: string } } };
    const bundlePath = launcher.leadAgent?.path;
    if (bundlePath) {
      const record = JSON.parse(readFileSync(join(bundlePath, "source.json"), "utf8")) as {
        commit?: string;
      };
      if (record.commit) {
        source = {
          commit: record.commit,
          revision: launcher.leadAgent?.identity?.revision ?? "installed",
        };
      }
    }
  } catch {
    // No durable source record: the update notice stays off.
  }
  if (source) {
    const record = source;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const checkout = await inspectLocalSourceCheckout(process.cwd(), record.commit);
        status = checkout
          ? {
              installedRevision: record.revision,
              installedCommit: record.commit,
              repositoryCommit: checkout.headCommit,
              updateAvailable: checkout.headCommit.toLowerCase() !== record.commit.toLowerCase(),
            }
          : undefined;
      } catch {
        status = undefined;
      } finally {
        checking = false;
      }
    };
    void check();
    setInterval(() => void check(), 60_000).unref();
  }
  return () => status;
}

function requiredArgument(name: string): string {
  const index = process.argv.lastIndexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
