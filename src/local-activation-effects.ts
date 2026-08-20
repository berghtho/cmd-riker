import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openAuthoritativeState } from "./authoritative-state/index.ts";
import { assessActivationBarrier, assessHostHealth } from "./host-health.ts";
import {
  connectLocalLeadHost,
  localLeadHostAddress,
  startLocalLeadHost,
  type LocalLeadHostServer,
} from "./local-host/index.ts";
import { verifyLocalReleaseCandidate } from "./local-release/index.ts";
import type { ActivationEffects, CodeStatePair, HealthAssessment } from "./recovery-actor/index.ts";
import {
  recoverInterruptedAuthoritativeStateRestore,
  restoreAuthoritativeStateSnapshot,
} from "./state-snapshot/index.ts";
import {
  advanceWriteGeneration,
  readWriteGenerationHighWater,
} from "./write-generation.ts";

type CandidateLaunch = {
  server: LocalLeadHostServer;
  pair: CodeStatePair;
  attemptId: string;
  writeGeneration: number;
  nonce: string;
  stateDirectory: string;
  reported: {
    attemptId: string;
    candidateRevision: string;
    artifactDigest: string;
    handshakeNonce: string;
    pid: number;
  };
  exited: boolean;
};

export function createLocalActivationEffects(input: {
  installationRoot: string;
  stateDirectory: string;
  recoveryDirectory: string;
}): ActivationEffects {
  const launches = new Map<string, CandidateLaunch>();

  const verifyPair = async (pair: CodeStatePair) => {
    const release = await verifyLocalReleaseCandidate(pair.code.path, "lead-agent");
    if (
      release.identity.revision !== pair.code.revision ||
      release.identity.digest !== pair.code.digest ||
      release.runtime.version !== pair.code.runtime.version ||
      release.runtime.architecture !== pair.code.runtime.architecture
    ) {
      throw new Error("Lead Agent code identity does not match its verified immutable release.");
    }
    if (await digestFile(pair.state.snapshotPath) !== pair.state.digest) {
      throw new Error("Code-and-state pair snapshot digest does not match.");
    }
    return release;
  };

  const assessLaunch = async (launch: CandidateLaunch): Promise<HealthAssessment> => {
    if (launch.exited) return unknownHealth("Candidate process exited during activation probation.");
    const release = await verifyPair(launch.pair);
    return assessHostHealth({
      stateDirectory: launch.stateDirectory,
      expectedWriteGeneration: launch.writeGeneration,
      expectedAttemptId: launch.attemptId,
      reportedAttemptId: launch.reported.attemptId,
      expectedCandidateRevision: launch.pair.code.revision,
      reportedCandidateRevision: launch.reported.candidateRevision,
      expectedArtifactDigest: launch.pair.code.digest,
      observedArtifactDigest: release.identity.digest,
      expectedHandshakeNonce: launch.nonce,
      reportedHandshakeNonce: launch.reported.handshakeNonce,
      observedAt: new Date().toISOString(),
    });
  };

  return {
    async verifyCandidate(candidate, actor) {
      if (samePath(candidate.code.path, actor.path)) {
        throw new Error("A Lead Agent candidate cannot replace the protected Recovery Actor.");
      }
      await verifyPair(candidate);
    },
    async verifyRecoveryBaseline(baseline) {
      const temporaryState = await mkdtemp(join(tmpdir(), "cmd-riker-baseline-preflight-"));
      let server: LocalLeadHostServer | undefined;
      try {
        const release = await verifyPair(baseline);
        await copyFile(
          baseline.state.snapshotPath,
          join(temporaryState, "authoritative-state.sqlite"),
        );
        const generation = readSnapshotGeneration(baseline.state.snapshotPath);
        const attemptId = `baseline-preflight-${randomUUID()}`;
        const nonce = randomUUID();
        const address = localLeadHostAddress(join(input.installationRoot, attemptId));
        server = await startLocalLeadHost({
          address,
          executable: release.runtime.path,
          args: [
            release.entrypointPath,
            "--state-dir",
            temporaryState,
            "--write-generation",
            String(generation),
            "--hosted",
            "--activation-provisional",
            "--activation-attempt-id",
            attemptId,
            "--candidate-revision",
            baseline.code.revision,
            "--artifact-digest",
            baseline.code.digest,
            "--activation-handshake-nonce",
            nonce,
          ],
          env: minimalEnvironment(),
          async onStopIntent() {},
        });
        const client = await connectLocalLeadHost(address);
        try {
          const reported = await waitForActivationReady(client, nonce, 15_000);
          const launch: CandidateLaunch = {
            server,
            pair: baseline,
            attemptId,
            writeGeneration: generation,
            nonce,
            stateDirectory: temporaryState,
            reported,
            exited: false,
          };
          void server.exit.then(() => {
            launch.exited = true;
          });
          return await assessLaunch(launch);
        } finally {
          await client.detach();
        }
      } finally {
        await server?.stop();
        await rm(temporaryState, { recursive: true, force: true });
      }
    },
    async assessBarrier() {
      const generation = readGeneration(input.stateDirectory);
      const state = openAuthoritativeState(input.stateDirectory, { writeGeneration: generation });
      try {
        return assessActivationBarrier(state);
      } finally {
        state.close();
      }
    },
    async snapshotState(baseline) {
      await verifyPair(baseline);
    },
    async transferWriteGeneration(expected) {
      return advanceWriteGeneration(input.stateDirectory, expected);
    },
    async currentWriteGeneration() {
      const recovered = await recoverInterruptedAuthoritativeStateRestore(
        join(input.recoveryDirectory, "failed-evidence"),
      );
      if (recovered !== undefined) return recovered;
      try {
        return readGeneration(input.stateDirectory);
      } catch (error) {
        throw error;
      }
    },
    async launch(pair, context) {
      const release = await verifyPair(pair);
      const address = localLeadHostAddress(
        join(input.installationRoot, "activation", context.attemptId),
      );
      const startedAt = new Date().toISOString();
      const server = await startLocalLeadHost({
        address,
        executable: release.runtime.path,
        args: [
          release.entrypointPath,
          "--state-dir",
          input.stateDirectory,
          "--write-generation",
          String(context.writeGeneration),
          "--hosted",
          "--activation-provisional",
          "--activation-attempt-id",
          context.attemptId,
          "--candidate-revision",
          pair.code.revision,
          "--artifact-digest",
          pair.code.digest,
          "--activation-handshake-nonce",
          context.nonce,
        ],
        env: minimalEnvironment(),
        async onStopIntent() {},
      });
      const client = await connectLocalLeadHost(address);
      try {
        const reported = await waitForActivationReady(client, context.nonce, 15_000);
        const launch: CandidateLaunch = {
          server,
          pair,
          attemptId: context.attemptId,
          writeGeneration: context.writeGeneration,
          nonce: context.nonce,
          stateDirectory: input.stateDirectory,
          reported,
          exited: false,
        };
        void server.exit.then(() => {
          launch.exited = true;
        });
        launches.set(context.nonce, launch);
        return { pid: server.childPid, startedAt, nonce: context.nonce };
      } catch (error) {
        await server.stop();
        throw error;
      } finally {
        await client.detach();
      }
    },
    async assessHealth(_pair, context) {
      const launch = launches.get(context.process.nonce);
      return launch
        ? assessLaunch(launch)
        : unknownHealth("Candidate launch identity is unavailable.");
    },
    async awaitProbation(_pair, context) {
      const launch = launches.get(context.process.nonce);
      if (!launch) return unknownHealth("Candidate probation launch is unavailable.");
      let assessment: HealthAssessment = unknownHealth("Candidate probation did not run.");
      for (let check = 0; check < context.checks; check += 1) {
        if (Date.now() > Date.parse(context.deadline)) {
          return unknownHealth("Candidate probation deadline expired.");
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        assessment = await assessLaunch(launch);
        if (assessment.verdict !== "healthy") return assessment;
      }
      return assessment;
    },
    async terminate(process) {
      const launch = launches.get(process.nonce);
      if (!launch) return;
      launches.delete(process.nonce);
      await launch.server.stop();
    },
    async restoreBaseline(pair, failedGeneration) {
      await verifyPair(pair);
      const freshWriteGeneration = Math.max(
        failedGeneration,
        readWriteGenerationHighWater(input.stateDirectory) ?? 0,
      ) + 1;
      const evidenceDirectory = join(
        input.recoveryDirectory,
        "failed-evidence",
        `generation-${failedGeneration}-${pair.state.digest.slice(0, 16)}`,
      );
      await mkdir(evidenceDirectory, { recursive: true });
      await restoreAuthoritativeStateSnapshot({
        stateDirectory: input.stateDirectory,
        evidenceDirectory,
        snapshot: {
          revision: pair.state.revision,
          digest: pair.state.digest,
          path: pair.state.snapshotPath,
          writeGeneration: readSnapshotGeneration(pair.state.snapshotPath),
          provenance: `Recovery Baseline ${pair.state.revision}`,
        },
        expectedDigest: pair.state.digest,
        failedWriteGeneration: failedGeneration,
        freshWriteGeneration,
      });
      return freshWriteGeneration;
    },
    async restoredBaselineGeneration(pair, failedGeneration) {
      const database = new DatabaseSync(
        join(input.stateDirectory, "authoritative-state.sqlite"),
        { readOnly: true },
      );
      try {
        const marker = database
          .prepare(`
            SELECT snapshot_digest, snapshot_revision,
                   failed_write_generation, restored_write_generation
              FROM recovery_restore_marker
             WHERE singleton = 1
          `)
          .get() as {
          snapshot_digest: string;
          snapshot_revision: string;
          failed_write_generation: number;
          restored_write_generation: number;
        } | undefined;
        return marker &&
          marker.snapshot_digest === pair.state.digest &&
          marker.snapshot_revision === pair.state.revision &&
          marker.failed_write_generation === failedGeneration
          ? marker.restored_write_generation
          : undefined;
      } catch (error) {
        if (error instanceof Error && /no such table/.test(error.message)) return undefined;
        throw error;
      } finally {
        database.close();
      }
    },
  };
}

async function waitForActivationReady(
  client: Awaited<ReturnType<typeof connectLocalLeadHost>>,
  nonce: string,
  timeoutMs: number,
): Promise<CandidateLaunch["reported"]> {
  const parse = (line: string): CandidateLaunch["reported"] | undefined => {
    try {
      const value = JSON.parse(line) as CandidateLaunch["reported"] & { type?: string };
      return value.type === "CMD_RIKER_ACTIVATION_READY" && value.handshakeNonce === nonce
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  };
  for (const entry of client.transcript) {
    if (entry.source === "lead" && entry.stream === "stdout") {
      const reported = parse(entry.line);
      if (reported) return reported;
    }
  }
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Candidate did not complete the Recovery Actor handshake before deadline."));
    }, timeoutMs);
    const unsubscribe = client.onTranscriptEntry((entry) => {
      if (entry.source !== "lead" || entry.stream !== "stdout") return;
      const reported = parse(entry.line);
      if (!reported) return;
      clearTimeout(timeout);
      unsubscribe();
      resolvePromise(reported);
    });
  });
}

function readGeneration(stateDirectory: string): number {
  const database = new DatabaseSync(join(stateDirectory, "authoritative-state.sqlite"), {
    readOnly: true,
  });
  try {
    return (database
      .prepare("SELECT write_generation FROM lifecycle_metadata WHERE singleton = 1")
      .get() as { write_generation: number }).write_generation;
  } finally {
    database.close();
  }
}

function readSnapshotGeneration(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (database
      .prepare("SELECT write_generation FROM lifecycle_metadata WHERE singleton = 1")
      .get() as { write_generation: number }).write_generation;
  } finally {
    database.close();
  }
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function samePath(left: string, right: string): boolean {
  return left.replaceAll("/", "\\").toLowerCase() === right.replaceAll("/", "\\").toLowerCase();
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "PATH",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ];
  return Object.fromEntries(names.flatMap((name) =>
    process.env[name] ? [[name, process.env[name]]] : []
  ));
}

function unknownHealth(reason: string): HealthAssessment {
  return {
    verdict: "unknown",
    subject: "Lead Agent candidate",
    scope: "activation invariants",
    observedAt: new Date().toISOString(),
    evidence: [reason],
  };
}
