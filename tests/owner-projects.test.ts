import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAuthoritativeState } from "../src/authoritative-state/index.ts";
import { createOrchestrationCore } from "../src/orchestration-core/index.ts";
import {
  parseOwnerSessionControl,
  projectSessionView,
  renderOwnerProjects,
  renderOwnerSessions,
} from "../src/session-view/index.ts";

function ownerConfiguration() {
  return {
    targetProject: { path: "C:\\repos\\cmd-riker-target" },
    projects: [{ name: "survivors", path: "C:\\repos\\survivors" }],
    modelSelection: {
      provider: "local-openai" as const,
      model: "owner-model",
      api: "openai-completions" as const,
      baseUrl: "http://127.0.0.1:11434/v1",
    },
    modelPolicyRevision: "lead-policy-1",
  };
}

test("configured projects list the default Target Project first and bind sessions", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-projects-test-"));
  const state = openAuthoritativeState(stateDirectory);
  t.after(() => {
    state.close();
    return rm(stateDirectory, { recursive: true, force: true });
  });
  state.initialize(ownerConfiguration());

  assert.deepEqual(state.readConfiguredProjects(), [
    { name: "cmd-riker-target", path: "C:\\repos\\cmd-riker-target" },
    { name: "survivors", path: "C:\\repos\\survivors" },
  ]);

  state.appendOwnerSessionSnapshots([
    {
      id: "s-survivors",
      name: "",
      createdAt: new Date().toISOString(),
      projectPath: "C:\\repos\\survivors",
      state: "active",
    },
  ]);
  state.appendOwnerMessage("Baue das Void-Biom fertig.", "s-survivors");
  state.appendOwnerMessage("Riker-Statuszeile verbessern.");

  const snapshot = projectSessionView(state, { activeSessionId: "s-survivors" });
  assert.deepEqual(
    snapshot.sessions?.map((session) => [session.name, session.project]),
    [
      ["Riker-Statuszeile verbessern.", "cmd-riker-target"],
      ["Baue das Void-Biom fertig.", "survivors"],
    ],
  );
  assert.deepEqual(
    snapshot.projects?.map((project) => [project.name, project.sessionCount]),
    [
      ["cmd-riker-target", 1],
      ["survivors", 1],
    ],
  );

  const rendered = renderOwnerSessions(snapshot.sessions ?? []);
  assert.match(rendered, /\[survivors\] Baue das Void-Biom fertig\./);
  assert.match(renderOwnerProjects(snapshot.projects ?? []), /2\. survivors \| C:\\repos\\survivors/);

  assert.deepEqual(parseOwnerSessionControl(snapshot.sessions ?? [], "/session new survivors"), {
    kind: "new-session",
    project: "survivors",
  });
  assert.deepEqual(parseOwnerSessionControl(snapshot.sessions ?? [], "/session projects"), {
    kind: "list-projects",
  });
});

test("duplicate project names or paths refuse to initialize", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-projects-dup-test-"));
  const state = openAuthoritativeState(stateDirectory);
  t.after(() => {
    state.close();
    return rm(stateDirectory, { recursive: true, force: true });
  });
  const configuration = ownerConfiguration();
  configuration.projects.push({ name: "Survivors", path: "C:\\repos\\other" });
  assert.throws(() => state.initialize(configuration), /unique across the configuration/i);
});

test("any configured project passes the effectful delegation path gate", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-projects-gate-test-"));
  const state = openAuthoritativeState(stateDirectory);
  t.after(() => {
    state.close();
    return rm(stateDirectory, { recursive: true, force: true });
  });
  state.initialize(ownerConfiguration());
  const orchestration = createOrchestrationCore(state);
  const assignment = {
    objective: "Deliver the slice.",
    prompt: "Do the work.",
    modelSelection: { provider: "openai", model: "gpt-5-codex", nativeHarness: "codex" },
    modelPolicyRevision: "worker-policy-1",
    commitmentId: "missing-commitment",
  };

  // A secondary configured project clears the path gate and fails later on the
  // missing Commitment; an unconfigured path never gets that far.
  assert.throws(
    () =>
      orchestration.delegateEffectfulWorker({
        ...assignment,
        targetProjectPath: "C:\\repos\\survivors",
      } as Parameters<typeof orchestration.delegateEffectfulWorker>[0]),
    /active unblocked Commitment/i,
  );
  assert.throws(
    () =>
      orchestration.delegateEffectfulWorker({
        ...assignment,
        targetProjectPath: "C:\\repos\\somewhere-else",
      } as Parameters<typeof orchestration.delegateEffectfulWorker>[0]),
    /configured project checkout/i,
  );
});

test("Capability Notices remain scoped to their configured project", async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "cmd-riker-project-capability-test-"));
  const state = openAuthoritativeState(stateDirectory);
  t.after(() => {
    state.close();
    return rm(stateDirectory, { recursive: true, force: true });
  });
  state.initialize(ownerConfiguration());
  const orchestration = createOrchestrationCore(state);
  orchestration.observeCodexCapabilityUnavailable("default unavailable", "C:\\repos\\cmd-riker-target");
  orchestration.observeCodexCapabilityUnavailable("survivors unavailable", "C:\\repos\\survivors");

  assert.equal(
    state.readCapabilityNotice("codex-worker", "C:\\repos\\cmd-riker-target")?.detail,
    "default unavailable",
  );
  assert.equal(
    state.readCapabilityNotice("codex-worker", "C:\\repos\\survivors")?.detail,
    "survivors unavailable",
  );
  assert.deepEqual(
    projectSessionView(state, { targetProjectPath: "C:\\repos\\cmd-riker-target" }).notices,
    ["The Codex Worker capability is unavailable: default unavailable"],
  );
  assert.deepEqual(
    projectSessionView(state, { targetProjectPath: "C:\\repos\\survivors" }).notices,
    ["The Codex Worker capability is unavailable: survivors unavailable"],
  );
});
