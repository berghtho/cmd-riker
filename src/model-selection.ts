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
