import { createInterface } from "node:readline";

const sessionView = {
  leadAvailability: "available",
  activeWorkerCount: 1,
  workers: [
    {
      number: 1,
      workerSessionId: "worker-1",
      label: "Build the integration",
      status: "running",
      cancellable: true,
    },
  ],
  items: [],
  notices: [],
};

process.stdout.write("CMD Riker | Target Project: C:\\target-project\n");
process.stdout.write("Lead available | 1 Worker running | status clear\n");
process.stdout.write(`CMD_RIKER_SESSION_JSON:${JSON.stringify(sessionView)}\n`);
const conversation: Array<{ source: "owner" | "lead-agent"; content: string }> = [];
let sessionId = "session-1";
const configuredProjectPaths = process.env.CMD_RIKER_TEST_PROJECTS
  ? JSON.parse(process.env.CMD_RIKER_TEST_PROJECTS) as string[]
  : ["C:\\target-project", "C:\\second-project"];
let targetProjectPath = configuredProjectPaths[0]!;
const scoped = new Map(configuredProjectPaths.map((projectPath, index) => [
  projectPath,
  {
    sessionId: index === 0 ? "target-session-1" : `project-${index + 1}-session-1`,
    conversation: [] as typeof conversation,
  },
]));
const emitConversation = () => process.stdout.write(
  `CMD_RIKER_OWNER_CONVERSATION:${JSON.stringify({
    sessionId,
    targetProjectPath,
    entries: conversation,
  })}\n`,
);
emitConversation();
emitProjectCatalog();
for (const [projectPath, project] of scoped) emitScopedProjection(projectPath, project);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const wireLine of lines) {
  const framed = wireLine.startsWith("CMD_RIKER_OWNER_INPUT:")
    ? JSON.parse(wireLine.slice("CMD_RIKER_OWNER_INPUT:".length)) as {
        content: string;
        targetProjectPath?: string;
        sessionId?: string;
      }
    : { content: wireLine };
  const line = framed.content;
  if (line === "exit before durable acknowledgement") process.exit(23);
  const display = line.replaceAll("\n", " / ");
  process.stdout.write(`CMD_RIKER_OWNER_RECORDED:turn-${display}\n`);
  await new Promise((resolve) =>
    line === "slow turn" ? setTimeout(resolve, 100) : setImmediate(resolve)
  );
  process.stdout.write(`CMD_RIKER_WORKER_NOTICE: Worker needs input for ${display}\n`);
  process.stdout.write(
    `CMD_RIKER_OWNER_RESPONSE:${JSON.stringify({
      source: "Lead Agent",
      content: `completed ${display}\nverified`,
    })}\n`,
  );
  process.stdout.write("Lead available | 1 Worker running | status clear\n");
  process.stdout.write(`CMD_RIKER_SESSION_JSON:${JSON.stringify(sessionView)}\n`);
  if (framed.targetProjectPath) {
    const project = scoped.get(framed.targetProjectPath);
    if (!project) throw new Error("unknown scoped project");
    if (framed.sessionId && framed.sessionId !== project.sessionId) {
      const selected = [...scoped.values()].find((candidate) => candidate.sessionId === framed.sessionId);
      if (selected !== project) throw new Error("session belongs to another project");
    }
    if (line.startsWith("/session new")) {
      project.sessionId = `${framed.targetProjectPath}-session-${Date.now()}`;
      project.conversation = [];
    } else {
      project.conversation.push(
        { source: "owner", content: line },
        { source: "lead-agent", content: `completed ${display}\nverified` },
      );
    }
    emitProjectCatalog();
    for (const [projectPath, current] of scoped) emitScopedProjection(projectPath, current);
  } else if (line === "/session new second-project") {
    conversation.splice(0);
    sessionId = "session-2";
    targetProjectPath = "C:\\second-project";
  }
  else {
    conversation.push(
      { source: "owner", content: line },
      { source: "lead-agent", content: `completed ${display}\nverified` },
    );
  }
  if (!framed.targetProjectPath) emitConversation();
  process.stdout.write("CMD_RIKER_OWNER_TURN_COMPLETE\n");
}

function emitProjectCatalog(): void {
  process.stdout.write(`CMD_RIKER_OWNER_PROJECTS:${JSON.stringify({
    projects: [...scoped].map(([targetProjectPath, project]) => ({
      targetProjectPath,
      sessionId: project.sessionId,
    })),
  })}\n`);
}

function emitScopedProjection(
  projectPath: string,
  project: { sessionId: string; conversation: typeof conversation },
): void {
  const initialSession = project.sessionId === "target-session-1" ||
    /^project-\d+-session-1$/.test(project.sessionId);
  process.stdout.write(`CMD_RIKER_OWNER_SESSION_VIEW:${JSON.stringify({
    targetProjectPath: projectPath,
    sessionId: project.sessionId,
    snapshot: {
      ...sessionView,
      lead: {
        provider: "test",
        model: initialSession ? "initial-session-model" : "new-session-model",
        contextTokens: initialSession ? 100 : 200,
        contextWindow: 1_000,
      },
      sessions: [{
        number: 1,
        sessionId: project.sessionId,
        name: "Scoped session",
        current: true,
        lastActiveAt: "2026-08-26T00:00:00.000Z",
        state: "active",
      }],
      projects: [{ number: 1, name: "project", path: projectPath, sessionCount: 1 }],
    },
  })}\n`);
  process.stdout.write(`CMD_RIKER_OWNER_CONVERSATION:${JSON.stringify({
    sessionId: project.sessionId,
    targetProjectPath: projectPath,
    entries: project.conversation,
  })}\n`);
}
