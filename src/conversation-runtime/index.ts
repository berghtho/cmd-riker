import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import {
  InMemoryModelsStore,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { ConversationMessage } from "../authoritative-state/index.ts";
import {
  assertSupportedModelSelection,
  type ModelSelection,
} from "../model-selection.ts";

export type PiTurnRequest = {
  conversation: readonly ConversationMessage[];
  ownerInput: string;
  modelSelection: ModelSelection;
};

export interface PiTurnAdapter {
  completeTurn(request: PiTurnRequest): Promise<{ content: string }>;
}

export class DeterministicTurnAdapter implements PiTurnAdapter {
  private readonly response: string | undefined;

  constructor(response?: string) {
    this.response = response;
  }

  async completeTurn(request: PiTurnRequest): Promise<{ content: string }> {
    const priorTurns = request.conversation.filter((message) => message.role === "lead-agent").length;
    return {
      content:
        this.response ?? `Deterministic turn ${priorTurns + 1}: ${request.ownerInput}`,
    };
  }
}

export class PiAgentTurnAdapter implements PiTurnAdapter {
  // Pi owns credential resolution and refresh; no credential crosses this adapter's interface.
  private authenticatedModels: Promise<ModelRuntime> | undefined;

  async completeTurn(request: PiTurnRequest): Promise<{ content: string }> {
    assertSupportedModelSelection(request.modelSelection);
    const execution = await this.resolveExecution(request.modelSelection);
    const initialState = {
      systemPrompt:
        "You are CMD Riker's Lead Agent: confident, composed, warm, observant, decisive, candid, " +
        "occasionally witty, proactive, and loyal to the Owner's intent without becoming passive. " +
        "Enjoy the work, challenge weak plans professionally, and serve the Owner without theatrical role-play.",
      model: execution.model,
      messages: request.conversation.map(toPiMessage),
      // Tools remain closed until their authority and durable effect paths exist.
      tools: [],
    };
    const agent = new Agent(
      request.modelSelection.api === "openai-completions"
        ? {
            initialState,
            streamFn: execution.streamFn,
            // Pi's OpenAI client requires a value, while the supported loopback endpoint is keyless.
            // This fixed public marker prevents any environment credential lookup.
            getApiKey: () => "cmd-riker-local-no-secret",
          }
        : {
            initialState,
            streamFn: execution.streamFn,
          },
    );

    await agent.prompt(request.ownerInput);
    const response = agent.state.messages.at(-1);
    if (!response || response.role !== "assistant") {
      throw new Error("Pi turn completed without an assistant response.");
    }
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(`Pi turn failed: ${response.errorMessage ?? response.stopReason}.`);
    }
    if (
      response.provider !== request.modelSelection.provider ||
      response.model !== request.modelSelection.model ||
      response.api !== request.modelSelection.api
    ) {
      throw new Error("Pi turn returned a different Model Selection than requested.");
    }
    const content = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    if (!content) throw new Error("Pi turn completed without response text.");
    return { content };
  }

  private async resolveExecution(selection: ModelSelection): Promise<{
    model: Model<Api>;
    streamFn: ModelRuntime["streamSimple"];
  }> {
    if (selection.api === "openai-completions") {
      return {
        model: toPiModel(selection),
        streamFn: streamSimple,
      };
    }
    this.authenticatedModels ??= import("@earendil-works/pi-coding-agent").then(
      ({ ModelRuntime }) =>
        ModelRuntime.create({
          allowModelNetwork: false,
          modelsPath: null,
          modelsStore: new InMemoryModelsStore(),
          refreshOnCreate: false,
        }),
    );
    const models = await this.authenticatedModels;
    const model = models.getModel(selection.provider, selection.model);
    if (!model) {
      throw new Error(`Configured Model ${selection.provider}/${selection.model} is unavailable.`);
    }
    if (
      model.provider !== selection.provider ||
      model.id !== selection.model ||
      model.api !== selection.api ||
      model.baseUrl !== "https://chatgpt.com/backend-api"
    ) {
      throw new Error("Pi resolved an unexpected OpenAI Codex Model definition.");
    }
    const auth = await models.checkAuth(selection.provider);
    if (!auth) {
      throw new Error(`Pi authentication for ${selection.provider} is unavailable.`);
    }
    return {
      model,
      streamFn: models.streamSimple.bind(models),
    };
  }
}

function toPiModel(
  selection: Extract<ModelSelection, { api: "openai-completions" }>,
): Model<"openai-completions"> {
  return {
    id: selection.model,
    name: selection.model,
    api: selection.api,
    provider: selection.provider,
    baseUrl: selection.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_768,
    maxTokens: 4_096,
  };
}

function toPiMessage(message: ConversationMessage): AgentMessage {
  if (message.role === "owner") {
    return { role: "user", content: message.content, timestamp: message.sequence };
  }
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: message.modelSelection.api,
    provider: message.modelSelection.provider,
    model: message.modelSelection.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: message.sequence,
  };
  return assistant;
}
