import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import {
  DeterministicTurnAdapter,
  PiAgentTurnAdapter,
  type PiTurnRequest,
} from "../src/conversation-runtime/index.ts";
import { createLeadAgentRuntime } from "../src/lead-agent-runtime/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";
import { startLocalModel } from "./support/local-model.ts";

const execFileAsync = promisify(execFile);

test("an Owner verdict settles a Commitment as durable Owner acceptance", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-owner-verdict-state-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  const orchestration = createOrchestrationCore(state);
  const ownerTurnId = state.appendOwnerMessage("Implement the bounded change.");
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The bounded Target Project change passes its declared tests.",
    criteria: [{
      kind: "target-project-operation",
      description: "The declared Target Project tests pass.",
      operation: "test",
    }],
  });
  const pin = "a".repeat(40);

  await assert.rejects(
    async () => orchestration.recordOwnerVerdict(commitment.id, ownerTurnId, {
      ownerVerdictQuote: "   ",
    }),
    /Owner's own words/,
  );
  await assert.rejects(
    async () => orchestration.recordOwnerVerdict(commitment.id, ownerTurnId, {
      ownerVerdictQuote: "Verified, works on my machine.",
      targetProjectHeadCommit: "not-a-sha",
    }),
    /full Target Project commit SHA/,
  );

  const accepted = orchestration.recordOwnerVerdict(commitment.id, ownerTurnId, {
    ownerVerdictQuote: "Verified, works on my machine.",
    targetProjectHeadCommit: pin,
  });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.acceptance?.authority, "owner");
  assert.equal(
    accepted.acceptance?.authority === "owner" ? accepted.acceptance.basis : undefined,
    "owner-verdict",
  );

  await assert.rejects(
    async () => orchestration.recordOwnerVerdict(commitment.id, ownerTurnId, {
      ownerVerdictQuote: "Verified again.",
    }),
    /already terminal/,
  );
  state.close();

  state = openAuthoritativeState(stateDirectory);
  const durable = state.readCommitment(commitment.id);
  state.close();
  assert.equal(durable?.state, "accepted");
  assert.equal(durable?.acceptance?.authority, "owner");
  if (durable?.acceptance?.authority !== "owner") assert.fail("Owner acceptance was not durable.");
  assert.equal(durable.acceptance.ownerVerdictQuote, "Verified, works on my machine.");
  assert.equal(durable.acceptance.targetProjectHeadCommit, pin);
  assert.equal(durable.acceptance.ownerTurnId, ownerTurnId);
});

test("Lead runtime pins the recorded Owner verdict to the Target Project head commit", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-owner-verdict-pin-state-"));
  const checkout = await mkdtemp(join(tmpdir(), "cmd-riker-owner-verdict-pin-project-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await execGit(checkout, ["init", "-b", "main"]);
  await execGit(checkout, ["config", "user.name", "CMD Riker Owner Verdict Test"]);
  await execGit(checkout, ["config", "user.email", "cmd-riker@example.invalid"]);
  await writeFile(join(checkout, "README.md"), "target project\n");
  await execGit(checkout, ["add", "README.md"]);
  await execGit(checkout, ["commit", "-m", "test: establish target project"]);
  const head = (await execGit(checkout, ["rev-parse", "HEAD"])).trim();

  const state = openAuthoritativeState(stateDirectory);
  state.initialize({
    targetProject: { path: checkout },
    modelSelection: {
      provider: "local-openai",
      model: "owner-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "owner-policy-1",
  });
  const orchestration = createOrchestrationCore(state);
  const ownerTurnId = state.appendOwnerMessage("Implement the bounded change.");
  const commitment = orchestration.recordCommitment(ownerTurnId, {
    outcome: "The bounded Target Project change passes its declared tests.",
    criteria: [{
      kind: "target-project-operation",
      description: "The declared Target Project tests pass.",
      operation: "test",
    }],
  });
  class VerdictAdapter extends DeterministicTurnAdapter {
    override async completeTurn(request: PiTurnRequest): Promise<{ content: string }> {
      await request.commitmentActions!.recordOwnerVerdict!(
        commitment.id,
        "Verified — the change works end to end.",
      );
      return { content: "The Owner verdict is recorded." };
    }
  }

  await createLeadAgentRuntime({
    state,
    adapter: new VerdictAdapter(),
  }).completeOwnerTurn("Verified — the change works end to end.");

  const accepted = state.readCommitment(commitment.id);
  state.close();
  assert.equal(accepted?.state, "accepted");
  if (accepted?.acceptance?.authority !== "owner") assert.fail("Owner acceptance was not recorded.");
  assert.equal(accepted.acceptance.targetProjectHeadCommit, head);
  assert.equal(accepted.acceptance.ownerVerdictQuote, "Verified — the change works end to end.");
});

test("production adapter records an Owner verdict through the bounded tool and reports it back", async (t) => {
  let recorded: { workItemId: string; ownerVerdictQuote: string } | undefined;
  let firstRequest = "";
  let lastRequest = "";
  const pin = "b".repeat(40);
  const acceptedCommitment = {
    id: "commitment-1",
    outcome: "The requested change is delivered.",
    criteria: [],
    createdByOwnerTurnId: "owner-turn-1",
    activeOwnerTurnId: "owner-turn-1",
    state: "accepted" as const,
    acceptance: {
      authority: "owner" as const,
      basis: "owner-verdict" as const,
      ownerTurnId: "owner-turn-1",
      acceptedAt: "2026-08-24T10:00:00.000Z",
      ownerVerdictQuote: "Verified, ship it.",
      targetProjectHeadCommit: pin,
    },
  };
  const localModel = await startLocalModel((call, requestBody) => {
    if (call === 1) {
      firstRequest = JSON.stringify(requestBody);
      return {
        toolCall: {
          id: "owner-verdict-call-1",
          name: "record_owner_verdict",
          arguments: {
            workItemId: "commitment-1",
            ownerVerdictQuote: "Verified, ship it.",
          },
        },
      };
    }
    lastRequest = JSON.stringify(requestBody);
    return "The Owner verdict stands durably.";
  });
  t.after(() => localModel.close());

  const commitmentActions: NonNullable<PiTurnRequest["commitmentActions"]> = {
    resume() {},
    cancel() {},
    async recordOwnerVerdict(workItemId, ownerVerdictQuote) {
      recorded = { workItemId, ownerVerdictQuote };
      return acceptedCommitment;
    },
    async executeOperation() {
      throw new Error("The operation is not part of this test.");
    },
  };
  const selection = {
    provider: "local-openai",
    model: "owner-model",
    api: "openai-completions",
    baseUrl: localModel.baseUrl,
  } as const;
  const result = await new PiAgentTurnAdapter().completeTurn({
    conversation: [],
    ownerInput: "Verified, ship it.",
    modelSelection: selection,
    commitmentActions,
  });

  assert.deepEqual(recorded, {
    workItemId: "commitment-1",
    ownerVerdictQuote: "Verified, ship it.",
  });
  assert.match(firstRequest, /record_owner_verdict/);
  assert.match(lastRequest, new RegExp(`pinned to Target Project commit ${pin}`));
  assert.equal(result.content, "The Owner verdict stands durably.");

  // A later turn sees the durable verdict in its Work Item context and needs no re-verification.
  await new PiAgentTurnAdapter().completeTurn({
    conversation: [],
    ownerInput: "Where do we stand?",
    modelSelection: selection,
    commitments: [acceptedCommitment],
    commitmentActions,
  });
  assert.match(lastRequest, /Owner-verified/);
  assert.match(lastRequest, new RegExp(`pinned to Target Project commit ${pin}`));
});

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true });
  return stdout;
}
