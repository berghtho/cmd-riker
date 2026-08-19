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
  type PiTurnAdapter,
} from "./conversation-runtime/index.ts";
import {
  assertSupportedModelSelection,
  type ModelSelection,
} from "./model-selection.ts";

async function main(): Promise<void> {
  const stateDirectory = argumentValue("--state-dir");
  if (!stateDirectory) throw new Error("--state-dir is required.");

  const state = openAuthoritativeState(stateDirectory);
  try {
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
      state.initialize(configuration);
      conversation = state.readOwnerConversation();
    }
    if (!conversation) throw new Error("Authoritative state could not be initialized.");

    const adapter: PiTurnAdapter = new PiAgentTurnAdapter();
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
  const turnId = state.appendOwnerMessage(ownerInput);
  let response: { content: string };
  try {
    response = await adapter.completeTurn({
      conversation: conversation.messages,
      ownerInput,
      modelSelection: conversation.modelSelection,
    });
  } catch {
    throw new HostDiagnostic(
      "CMD_RIKER_MODEL_UNAVAILABLE",
      "The configured Model did not complete the turn.",
    );
  }
  state.appendLeadAgentMessage(turnId, response.content);
  return response.content;
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
  if (!isRecordWithKeys(value, ["targetProject", "modelSelection", "modelPolicyRevision"])) {
    throw invalidConfiguration();
  }
  const targetProject = value.targetProject;
  const modelSelection = value.modelSelection;
  if (
    !isRecordWithKeys(targetProject, ["path"]) ||
    typeof targetProject.path !== "string" ||
    !targetProject.path.trim() ||
    typeof value.modelPolicyRevision !== "string" ||
    !value.modelPolicyRevision.trim()
  ) {
    throw invalidConfiguration();
  }
  const selection = parseModelSelection(modelSelection);
  try {
    assertSupportedModelSelection(selection);
  } catch {
    throw invalidConfiguration();
  }
  return {
    targetProject: { path: targetProject.path },
    modelSelection: selection,
    modelPolicyRevision: value.modelPolicyRevision,
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
