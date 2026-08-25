export type LeadThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export const leadThinkingLevels: readonly LeadThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/**
 * What one completed Lead turn actually ran on: the attributed Model, the
 * effective reasoning budget, and the context the turn occupied. Context
 * numbers are measured from the provider's usage report, never estimated.
 */
export type LeadTurnMetrics = {
  provider: string;
  model: string;
  thinkingLevel?: LeadThinkingLevel;
  contextTokens: number;
  contextWindow: number | null;
};

export type ModelSelection =
  | {
      provider: string;
      model: string;
      api: "openai-completions";
      baseUrl: string;
    }
  | {
      provider: "openai-codex";
      model: string;
      api: "openai-codex-responses";
      /** Reasoning budget for the Lead turn; omitted means the full "xhigh" budget. */
      thinkingLevel?: LeadThinkingLevel;
    };

export function assertSupportedModelSelection(selection: ModelSelection): void {
  if (selection.api === "openai-codex-responses") {
    if (selection.provider !== "openai-codex") {
      throw new Error("OpenAI Codex Models require the openai-codex provider.");
    }
    return;
  }
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
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error(
      "Model base URL must not contain credentials, query parameters, or fragments.",
    );
  }
}
