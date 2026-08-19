import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  Input,
  Key,
  matchesKey,
  ProcessTerminal,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";

import {
  openAuthoritativeState,
  type AuthoritativeState,
  type OwnerConfiguration,
} from "./authoritative-state/index.ts";
import {
  PiAgentTurnAdapter,
  PiTurnFailure,
  type PiTurnAdapter,
} from "./conversation-runtime/index.ts";
import {
  assertSupportedModelSelection,
  type ModelSelection,
} from "./model-selection.ts";
import {
  assertValidatedLeadModelPolicy,
  createOrchestrationCore,
  defaultLeadModelRequirements,
  type LeadModelRequirements,
  type LeadModelPolicy,
} from "./orchestration-core/index.ts";

async function main(): Promise<void> {
  const stateDirectory = argumentValue("--state-dir");
  if (!stateDirectory) throw new Error("--state-dir is required.");

  const state = openAuthoritativeState(stateDirectory);
  const adapter: PiTurnAdapter = new PiAgentTurnAdapter();
  try {
    let policyValidated = false;
    let conversation = state.readOwnerConversation();
    if (!conversation) {
      let configurationText: string;
      try {
        configurationText = await readFile(join(stateDirectory, "config.json"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new HostDiagnostic(
            "CMD_RIKER_CONFIG_MISSING",
            "Uninitialized state requires config.json in the state directory.",
          );
        }
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(configurationText);
      } catch {
        throw invalidConfiguration();
      }
      const configuration = parseConfiguration(parsed);
      await validatePolicy(adapter, configuration);
      policyValidated = true;
      state.initialize(configuration);
      conversation = state.readOwnerConversation();
    }
    if (!conversation) throw new Error("Authoritative state could not be initialized.");
    createOrchestrationCore(state).reconcileInterruptedCommitments();
    if (!policyValidated) await validatePolicy(adapter, conversation);

    if (process.stdin.isTTY && process.stdout.isTTY) {
      await runInteractiveConversation(state, adapter, conversation.targetProject.path);
    } else {
      await runScriptableConversation(state, adapter, conversation.targetProject.path);
    }
  } finally {
    state.close();
  }
}

async function runScriptableConversation(
  state: AuthoritativeState,
  adapter: PiTurnAdapter,
  targetProjectPath: string,
): Promise<void> {
  process.stdout.write(`CMD Riker | Target Project: ${targetProjectPath}\n`);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const ownerInput of lines) {
    if (!ownerInput.trim()) continue;
    const content = await completeOwnerTurn(state, adapter, ownerInput);
    process.stdout.write(`Lead Agent: ${content}\n`);
  }
}

function runInteractiveConversation(
  state: AuthoritativeState,
  adapter: PiTurnAdapter,
  targetProjectPath: string,
): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const conversation = state.readOwnerConversation();
  const transcriptLines = (conversation?.messages ?? []).map((message) =>
    `${message.role === "owner" ? "Owner" : "Lead Agent"}: ${message.content}`,
  );
  transcriptLines.push(...state.readCommitments().map(commitmentNotice));
  const transcript = new Text(transcriptLines.join("\n\n"));
  const input = new Input();
  let busy = false;
  let stopRequested = false;

  tui.addChild(new Text(`CMD Riker | Target Project: ${targetProjectPath}`));
  tui.addChild(transcript);
  tui.addChild(new Text("Owner:"));
  tui.addChild(input);
  tui.setFocus(input);

  return new Promise((resolve, reject) => {
    const stop = () => {
      if (busy) {
        stopRequested = true;
        return;
      }
      tui.stop();
      resolve();
    };
    tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        stop();
        return { consume: true };
      }
      return undefined;
    });
    input.onSubmit = (ownerInput) => {
      if (busy || !ownerInput.trim()) return;
      busy = true;
      input.setValue("");
      transcriptLines.push(`Owner: ${ownerInput}`, "Lead Agent: thinking...");
      transcript.setText(transcriptLines.join("\n\n"));
      tui.requestRender();
      void completeOwnerTurn(state, adapter, ownerInput)
        .then((content) => {
          transcriptLines[transcriptLines.length - 1] = `Lead Agent: ${content}`;
          transcript.setText(transcriptLines.join("\n\n"));
          busy = false;
          if (stopRequested) stop();
          else tui.requestRender();
        })
        .catch((error: unknown) => {
          tui.stop();
          reject(error);
        });
    };
    input.onEscape = stop;
    tui.start();
  });
}

async function completeOwnerTurn(
  state: AuthoritativeState,
  adapter: PiTurnAdapter,
  ownerInput: string,
): Promise<string> {
  const conversation = state.readOwnerConversation();
  if (!conversation) throw new Error("Authoritative state is not configured.");
  const orchestration = createOrchestrationCore(state);
  const turnId = state.appendOwnerMessage(ownerInput);
  const commitmentsBefore = new Map(
    state
      .readCommitments()
      .map((commitment) => [commitment.id, commitmentFingerprint(commitment)]),
  );
  const candidates = [conversation.modelSelection, ...(conversation.modelFallbacks ?? [])];
  for (const [index, modelSelection] of candidates.entries()) {
    const validation = await adapter.validateSelection(
      modelSelection,
      conversation.modelRequirements ?? defaultLeadModelRequirements,
    );
    if (orchestration.modelCandidateDecision(validation) === "skip") continue;
    const attempt = orchestration.startLeadTurnAttempt({
      ownerTurnId: turnId,
      modelSelection,
      modelPolicyRevision: conversation.modelPolicyRevision,
      ...(index > 0
        ? { selectionReason: "fallback-after-ineligible-candidate" as const }
        : {}),
    });
    try {
      const response = await adapter.completeTurn({
        conversation: conversation.messages,
        ownerInput,
        modelSelection,
        commitments: state.readCommitments(),
        commitmentActions: {
          record: (draft) => orchestration.recordCommitment(turnId, draft),
          accept: (commitmentId) => orchestration.acceptCommitment(commitmentId, turnId),
          resume: (commitmentId) => orchestration.resumeCommitment(commitmentId, turnId),
          control: (commitmentId, action, reason, replacementCommitmentId) => {
            if (action === "pause") orchestration.pauseCommitment(commitmentId, turnId, reason);
            else if (action === "cancel") {
              orchestration.cancelCommitment(commitmentId, turnId, reason);
            } else {
              if (!replacementCommitmentId) {
                throw new Error("Supersession requires a replacement Commitment.");
              }
              orchestration.supersedeCommitment(
                commitmentId,
                turnId,
                reason,
                replacementCommitmentId,
              );
            }
          },
        },
      });
      state.appendLeadAgentMessage(turnId, response.content, {
        modelSelection,
        modelPolicyRevision: conversation.modelPolicyRevision,
        ...(index > 0
          ? { selectionReason: "fallback-after-ineligible-candidate" as const }
          : {}),
      });
      orchestration.observeLeadResponse(turnId, response.content);
      const notices = state
        .readCommitments()
        .filter(
          (commitment) =>
            commitmentsBefore.get(commitment.id) !== commitmentFingerprint(commitment),
        )
        .map(commitmentNotice);
      const content = notices.length
        ? `${response.content}\n\n${notices.join("\n")}`
        : response.content;
      orchestration.settleLeadTurnAttempt(attempt.id, "completed");
      return content;
    } catch (error) {
      if (!(error instanceof PiTurnFailure)) throw error;
      orchestration.settleLeadTurnAttempt(attempt.id, "failed", error.kind);
      const decision = orchestration.modelFailureDecision(error);
      if (decision === "fallback") continue;
      if (decision === "revalidate") {
        const updatedValidation = await adapter.validateSelection(
          modelSelection,
          conversation.modelRequirements ?? defaultLeadModelRequirements,
        );
        if (orchestration.modelCandidateDecision(updatedValidation) === "skip") continue;
      }
      orchestration.observeLeadTurnFailure(turnId, `Lead Model turn failed: ${error.kind}.`);
      break;
    }
  }
  throw new HostDiagnostic(
    "CMD_RIKER_MODEL_UNAVAILABLE",
    "The configured Model did not complete the turn.",
  );
}

function commitmentFingerprint(commitment: {
  state: string;
  condition?: { kind: string };
}): string {
  return `${commitment.state}:${commitment.condition?.kind ?? "none"}`;
}

function commitmentNotice(commitment: {
  id: string;
  outcome: string;
  state: string;
  condition?: { kind: string };
}): string {
  const status =
    commitment.state === "awaiting-acceptance"
      ? "awaiting Owner Acceptance"
      : commitment.condition?.kind ?? commitment.state;
  return `Commitment ${commitment.id} ${status}: ${commitment.outcome}`;
}

async function validatePolicy(
  adapter: PiTurnAdapter,
  configuration: OwnerConfiguration,
): Promise<void> {
  const policy = leadModelPolicy(configuration);
  const validations = [];
  for (const modelSelection of [policy.default, ...policy.fallbacks]) {
    validations.push(await adapter.validateSelection(modelSelection, policy.requirements));
  }
  assertValidatedLeadModelPolicy(policy, validations);
}

function leadModelPolicy(configuration: OwnerConfiguration): LeadModelPolicy {
  return {
    revision: configuration.modelPolicyRevision,
    default: configuration.modelSelection,
    fallbacks: configuration.modelFallbacks ?? [],
    requirements: configuration.modelRequirements ?? defaultLeadModelRequirements,
  };
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

class HostDiagnostic extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function invalidConfiguration(): HostDiagnostic {
  return new HostDiagnostic(
    "CMD_RIKER_CONFIG_INVALID",
    "config.json must contain a valid supported Owner configuration.",
  );
}

function parseConfiguration(value: unknown): OwnerConfiguration {
  const legacyKeys = ["targetProject", "modelSelection", "modelPolicyRevision"];
  const acceptedKeySets = [
    legacyKeys,
    [...legacyKeys, "modelFallbacks"],
    [...legacyKeys, "modelRequirements"],
    [...legacyKeys, "modelFallbacks", "modelRequirements"],
  ];
  if (!acceptedKeySets.some((keys) => isRecordWithKeys(value, keys))) {
    throw invalidConfiguration();
  }
  const configuration = value as Record<string, unknown>;
  const targetProject = configuration.targetProject;
  const modelSelection = configuration.modelSelection;
  if (
    !isRecordWithKeys(targetProject, ["path"]) ||
    typeof targetProject.path !== "string" ||
    !targetProject.path.trim() ||
    typeof configuration.modelPolicyRevision !== "string" ||
    !configuration.modelPolicyRevision.trim()
  ) {
    throw invalidConfiguration();
  }
  const selection = parseModelSelection(modelSelection);
  const fallbacks = configuration.modelFallbacks;
  if (fallbacks !== undefined && !Array.isArray(fallbacks)) throw invalidConfiguration();
  const parsedFallbacks = fallbacks?.map(parseModelSelection);
  const requirements = configuration.modelRequirements !== undefined
    ? parseModelRequirements(configuration.modelRequirements)
    : undefined;
  try {
    assertSupportedModelSelection(selection);
    for (const fallback of parsedFallbacks ?? []) assertSupportedModelSelection(fallback);
  } catch {
    throw invalidConfiguration();
  }
  return {
    targetProject: { path: targetProject.path },
    modelSelection: selection,
    ...(parsedFallbacks ? { modelFallbacks: parsedFallbacks } : {}),
    ...(requirements ? { modelRequirements: requirements } : {}),
    modelPolicyRevision: configuration.modelPolicyRevision,
  };
}

function parseModelRequirements(value: unknown): LeadModelRequirements {
  if (!isRecordWithKeys(value, [
    "requiredCapabilities",
    "minimumContextWindow",
    "dataHandling",
    "maximumInputCostPerMillionUsd",
  ])) {
    throw invalidConfiguration();
  }
  if (
    !Array.isArray(value.requiredCapabilities) ||
    value.requiredCapabilities.length === 0 ||
    !value.requiredCapabilities.every(
      (capability) => capability === "text" || capability === "image",
    ) ||
    typeof value.minimumContextWindow !== "number" ||
    !Number.isInteger(value.minimumContextWindow) ||
    value.minimumContextWindow < 1 ||
    (value.dataHandling !== "loopback-only" &&
      value.dataHandling !== "supported-integrations") ||
    (value.maximumInputCostPerMillionUsd !== null &&
      (typeof value.maximumInputCostPerMillionUsd !== "number" ||
        !Number.isFinite(value.maximumInputCostPerMillionUsd) ||
        value.maximumInputCostPerMillionUsd < 0))
  ) {
    throw invalidConfiguration();
  }
  return {
    requiredCapabilities: value.requiredCapabilities,
    minimumContextWindow: value.minimumContextWindow,
    dataHandling: value.dataHandling,
    maximumInputCostPerMillionUsd: value.maximumInputCostPerMillionUsd,
  };
}

function parseModelSelection(value: unknown): ModelSelection {
  if (!isRecordWithKeys(value, ["provider", "model", "api"])) {
    if (!isRecordWithKeys(value, ["provider", "model", "api", "baseUrl"])) {
      throw invalidConfiguration();
    }
    if (
      typeof value.provider !== "string" ||
      !value.provider.trim() ||
      typeof value.model !== "string" ||
      !value.model.trim() ||
      value.api !== "openai-completions" ||
      typeof value.baseUrl !== "string"
    ) {
      throw invalidConfiguration();
    }
    const selection: ModelSelection = {
      provider: value.provider,
      model: value.model,
      api: value.api,
      baseUrl: value.baseUrl,
    };
    try {
      assertSupportedModelSelection(selection);
    } catch {
      throw invalidConfiguration();
    }
    return selection;
  }
  if (
    value.provider !== "openai-codex" ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    value.api !== "openai-codex-responses"
  ) {
    throw invalidConfiguration();
  }
  return {
    provider: value.provider,
    model: value.model,
    api: value.api,
  };
}

function isRecordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

try {
  await main();
} catch (error) {
  if (error instanceof HostDiagnostic) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write("CMD_RIKER_HOST_FAILURE: The local host could not continue.\n");
  }
  process.exitCode = 2;
}
