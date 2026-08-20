import type {
  LeadHostExit,
  LeadHostTranscriptEntry,
  LocalLeadHostClient,
} from "./local-host/index.ts";
import type { PiOwnerResponse } from "./pi-owner-interface.ts";

type OwnerHostClient = Pick<
  LocalLeadHostClient,
  "transcript" | "onTranscriptEntry" | "onExit" | "sendOwnerLine"
>;

export async function completeHostedOwnerInput(
  client: OwnerHostClient,
  ownerInput: string,
): Promise<PiOwnerResponse> {
  const completion = Promise.withResolvers<PiOwnerResponse>();
  const responsePromise = completion.promise;
  // Host exit can arrive while sendOwnerLine is still awaiting its durable ack.
  // Attach a rejection observer immediately so Pi receives the error instead of
  // Node escalating a temporarily unhandled rejection to uncaughtException.
  void responsePromise.catch(() => {});
  const responseLines: string[] = [];
  let source: PiOwnerResponse["source"] = "Lead Agent";
  const unsubscribeTranscript = client.onTranscriptEntry((entry: LeadHostTranscriptEntry) => {
    if (entry.source !== "lead" || entry.stream !== "stdout") return;
    if (/^Lead available\s+\|/.test(entry.line)) {
      completion.resolve({ source, content: responseLines.join("\n").trim() });
      return;
    }
    if (entry.line.startsWith("Lead Agent: ")) {
      source = "Lead Agent";
      responseLines.push(entry.line.slice("Lead Agent: ".length));
      return;
    }
    if (entry.line.startsWith("Session View: ")) {
      source = "Session View";
      responseLines.push(entry.line.slice("Session View: ".length));
      return;
    }
    if (!entry.line.startsWith("CMD_RIKER_") && responseLines.length > 0) {
      responseLines.push(entry.line);
    }
  });
  const unsubscribeExit = client.onExit((exit: LeadHostExit) => {
    completion.reject(new Error(`The Lead Agent stopped unexpectedly (${exit.kind}).`));
  });
  const timeout = setTimeout(() => {
    completion.reject(new Error("The Lead Agent did not finish the Owner turn within ten minutes."));
  }, 10 * 60_000);
  try {
    await client.sendOwnerLine(ownerInput);
    return await responsePromise;
  } finally {
    clearTimeout(timeout);
    unsubscribeExit();
    unsubscribeTranscript();
  }
}
