import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { localLeadHostAddress } from "./local-host/index.ts";
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

// The installed bundle records its source repository and commit; the client
// polls that repository's HEAD in the background so the interface can announce
// a newer version. Git failures or a missing source record simply disable the
// notice.
function createUpdateStatusReader(
  installationRoot: string,
): () => PiOwnerUpdateStatus | undefined {
  let status: PiOwnerUpdateStatus | undefined;
  let source: { repositoryPath: string; commit: string; revision: string } | undefined;
  try {
    const launcher = JSON.parse(
      readFileSync(join(installationRoot, "launcher", "installation.json"), "utf8"),
    ) as { leadAgent?: { path?: string; identity?: { revision?: string } } };
    const bundlePath = launcher.leadAgent?.path;
    if (bundlePath) {
      const record = JSON.parse(readFileSync(join(bundlePath, "source.json"), "utf8")) as {
        repositoryPath?: string;
        commit?: string;
      };
      if (record.repositoryPath && record.commit) {
        source = {
          repositoryPath: record.repositoryPath,
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
    const execute = promisify(execFile);
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const result = await execute(
          "git",
          ["-C", record.repositoryPath, "rev-parse", "HEAD"],
          { encoding: "utf8", timeout: 10_000, windowsHide: true },
        );
        const repositoryCommit = result.stdout.trim();
        status = /^[0-9a-f]{40}$/i.test(repositoryCommit)
          ? {
              installedRevision: record.revision,
              installedCommit: record.commit,
              repositoryCommit,
              updateAvailable: repositoryCommit.toLowerCase() !== record.commit.toLowerCase(),
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
