import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  deriveSessionName,
  openAuthoritativeState,
  primaryOwnerSessionId,
} from "../src/authoritative-state/index.ts";
import {
  parseOwnerSessionControl,
  projectSessionView,
  renderOwnerSessions,
  type SessionViewState,
} from "../src/session-view/index.ts";

function ownerConfiguration() {
  return {
    targetProject: { path: "C:\\target-project" },
    modelSelection: {
      provider: "local-openai" as const,
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "lead-policy-1",
  };
}

test("sessions are named by their first prompt, keep separate conversations, and survive restart", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-owner-sessions-test-"));
  let state = openAuthoritativeState(stateDirectory);
  t.after(() => {
    state.close();
    return rm(stateDirectory, { recursive: true, force: true });
  });
  state.initialize(ownerConfiguration());

  const firstTurn = state.appendOwnerMessage("Baue das Void-Biom fertig und melde dich.");
  state.appendLeadAgentMessage(firstTurn, "Verstanden.");

  const secondSession = "22222222-aaaa-bbbb-cccc-dddddddddddd";
  const secondTurn = state.appendOwnerMessage("Untersuche den Speicherleck-Verdacht.", secondSession);
  state.appendLeadAgentMessage(secondTurn, "Ich schaue es mir an.");

  // Each session holds only its own thread; the lead reply follows its owner turn.
  const primary = state.readOwnerConversation();
  const second = state.readOwnerConversation(secondSession);
  assert.deepEqual(
    primary?.messages.map((message) => message.content),
    ["Baue das Void-Biom fertig und melde dich.", "Verstanden."],
  );
  assert.deepEqual(
    second?.messages.map((message) => message.content),
    ["Untersuche den Speicherleck-Verdacht.", "Ich schaue es mir an."],
  );

  const sessions = state.readOwnerSessions();
  assert.deepEqual(
    sessions.map((session) => [session.id, session.name]),
    [
      [secondSession, "Untersuche den Speicherleck-Verdacht."],
      [primaryOwnerSessionId, "Baue das Void-Biom fertig und melde dich."],
    ],
  );
  assert.equal(state.latestActiveOwnerSessionId(), secondSession);

  state.close();
  state = openAuthoritativeState(stateDirectory);
  assert.equal(state.latestActiveOwnerSessionId(), secondSession);
  assert.equal(state.readOwnerSessions().length, 2);
  assert.equal(
    state.readOwnerConversation(secondSession)?.messages.length,
    2,
  );
});

test("a pre-created empty session takes its name from the first prompt it receives", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-owner-sessions-name-test-"));
  const state = openAuthoritativeState(stateDirectory);
  t.after(() => {
    state.close();
    return rm(stateDirectory, { recursive: true, force: true });
  });
  state.initialize(ownerConfiguration());
  const sessionId = "33333333-aaaa-bbbb-cccc-dddddddddddd";
  state.appendOwnerSessionSnapshots([
    { id: sessionId, name: "", createdAt: new Date().toISOString(), state: "active" },
  ]);
  state.appendOwnerMessage("Richte die Release-Pipeline ein.", sessionId);
  assert.equal(
    state.readOwnerSessions().find((session) => session.id === sessionId)?.name,
    "Richte die Release-Pipeline ein.",
  );
});

test("session names compact whitespace and cut long prompts at a word boundary", () => {
  assert.equal(deriveSessionName("  Fix   the\nbug  "), "Fix the bug");
  const name = deriveSessionName(
    "Untersuche warum der nächtliche Integrationslauf seit Dienstag sporadisch fehlschlägt und sammle Beweise",
  );
  assert.ok(name.length <= 49);
  assert.ok(name.endsWith("…"));
  assert.doesNotMatch(name, /\s…$/);
});

test("the Session View lists sessions and resolves switching controls", () => {
  const state = {
    readWorkerSessions: () => [],
    readWorkerExecutionAttempt: () => undefined,
    readWorkerQuestions: () => [],
    readEffectIntents: () => [],
    readCommitments: () => [],
    readCommitment: () => undefined,
    readCapabilityNotice: () => undefined,
    readForgeOwnerActionNotices: () => [],
    readOwnerSessions: () => [
      {
        id: "s2",
        name: "Speicherleck untersuchen",
        createdAt: "2026-08-25T10:00:00.000Z",
        state: "active" as const,
        lastActiveAt: "2026-08-25T12:00:00.000Z",
      },
      {
        id: "primary",
        name: "Void fertig bauen",
        createdAt: "2026-08-25T09:00:00.000Z",
        state: "active" as const,
        lastActiveAt: "2026-08-25T11:00:00.000Z",
      },
    ],
  } as SessionViewState;

  const snapshot = projectSessionView(state, { activeSessionId: "s2" });
  assert.deepEqual(
    snapshot.sessions?.map((session) => [session.number, session.sessionId, session.current]),
    [
      [1, "s2", true],
      [2, "primary", false],
    ],
  );

  const rendered = renderOwnerSessions(snapshot.sessions ?? []);
  assert.match(rendered, /1\. \* Speicherleck untersuchen/);
  assert.match(rendered, /2\. Void fertig bauen \| \/session use 2/);

  assert.deepEqual(parseOwnerSessionControl(snapshot.sessions ?? [], "/session use 2"), {
    kind: "use-session",
    sessionId: "primary",
    name: "Void fertig bauen",
  });
  assert.deepEqual(parseOwnerSessionControl(snapshot.sessions ?? [], "/session new"), {
    kind: "new-session",
  });
  assert.deepEqual(parseOwnerSessionControl(snapshot.sessions ?? [], "/session list"), {
    kind: "list-sessions",
  });
  assert.equal(parseOwnerSessionControl(snapshot.sessions ?? [], "/session use 7"), undefined);
});
