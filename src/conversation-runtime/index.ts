import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";

import type { ConversationMessage, ModelSelection } from "../authoritative-state/index.ts";

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
  async completeTurn(request: PiTurnRequest): Promise<{ content: string }> {
    assertSecretFreeLocalSelection(request.modelSelection);
    const model = toPiModel(request.modelSelection);
    const agent = new Agent({
      initialState: {
        systemPrompt:
          "You are CMD Riker's Lead Agent: confident, composed, warm, observant, decisive, and candid. " +
          "Serve the Owner without theatrical role-play.",
        model,
        messages: request.conversation.map(toPiMessage),
        tools: [],
      },
      streamFn: (selectedModel, context, options) =>
        streamSimple(selectedModel as Model<"openai-completions">, context, options),
      // Pi's OpenAI client requires a value, while the supported loopback endpoint is keyless.
      // This fixed public marker prevents any environment credential lookup.
      getApiKey: () => "cmd-riker-local-no-secret",
    });

    await agent.prompt(request.ownerInput);
    const response = agent.state.messages.at(-1);
    if (!response || response.role !== "assistant") {
      throw new Error("Pi turn completed without an assistant response.");
    }
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(`Pi turn failed: ${response.errorMessage ?? response.stopReason}.`);
    }
    const content = response.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    if (!content) throw new Error("Pi turn completed without response text.");
    return { content };
  }
}

function assertSecretFreeLocalSelection(selection: ModelSelection): void {
  let endpoint: URL;
  try {
    endpoint = new URL(selection.baseUrl);
  } catch {
    throw new Error("Model base URL is invalid.");
  }
  const loopback =
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "http:" || !loopback) {
    throw new Error(
      "Model integration is unavailable: only keyless loopback HTTP endpoints are supported.",
    );
  }
}

function toPiModel(selection: ModelSelection): Model<"openai-completions"> {
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
