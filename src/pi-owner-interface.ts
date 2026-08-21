import { readFileSync } from "node:fs";

import {
  getAgentDir,
  getMarkdownTheme,
  loadSkills,
  stripFrontmatter,
  type Theme,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

import type { SessionViewSnapshot } from "./session-view/index.ts";

// Pi intentionally does not export its CLI composition root. CMD Riker pins the
// package version and uses that root so Pi, rather than a look-alike TUI, owns the
// terminal lifecycle and interactive experience.
import { main as runPi } from "../node_modules/@earendil-works/pi-coding-agent/dist/main.js";

export type PiOwnerTranscriptEntry = {
  source: "owner" | "lead-agent";
  content: string;
};

export type PiOwnerResponse = {
  source: "Lead Agent" | "Session View";
  content: string;
};

export type PiOwnerInterfaceInput = {
  targetProjectPath: string;
  transcript: PiOwnerTranscriptEntry[];
  completeOwnerInput(ownerInput: string): Promise<PiOwnerResponse>;
  readSessionView(): string;
  readSessionData?(): SessionViewSnapshot | undefined;
  subscribeNotices?(listener: (content: string) => void): () => void;
};

export async function runPiOwnerInterface(input: PiOwnerInterfaceInput): Promise<void> {
  const previousDirectory = process.cwd();
  process.chdir(input.targetProjectPath);
  try {
    await runPi([
      "--no-session",
      "--no-builtin-tools",
      "--no-context-files",
      "--no-prompt-templates",
      "--offline",
      "--tui-mode",
      "fullscreen",
    ], {
      extensionFactories: [rikerOwnerExtension(input)],
    });
  } finally {
    process.chdir(previousDirectory);
  }
}

export function rikerOwnerExtension(input: PiOwnerInterfaceInput): InlineExtension {
  return {
    name: "CMD Riker",
    hidden: true,
    factory(pi) {
      installRikerOwnerExtension(pi, input);
    },
  };
}

function installRikerOwnerExtension(pi: ExtensionAPI, input: PiOwnerInterfaceInput): void {
  let footer: Text | undefined;
  let footerTheme: Theme | undefined;
  let status: "available" | "responding" | "error" = "available";
  let refreshTimer: NodeJS.Timeout | undefined;
  let unsubscribeNotices: (() => void) | undefined;

  pi.registerMessageRenderer("riker-owner", (message, { outputPad }, theme) => {
    const box = new Box(outputPad, 0, (text) => theme.bg("userMessageBg", text));
    box.addChild(new Markdown(String(message.content), 1, 1, getMarkdownTheme()));
    return box;
  });

  pi.registerMessageRenderer("riker-lead", (message, { outputPad }, theme) => {
    const box = new Box(outputPad, 0);
    box.addChild(new Text(theme.bold(theme.fg("accent", "Riker")), 1, 0));
    box.addChild(new Markdown(String(message.content), 1, 0, getMarkdownTheme()));
    return box;
  });

  pi.registerMessageRenderer("riker-error", (message, { outputPad }, theme) => {
    const box = new Box(outputPad, 0);
    box.addChild(new Text(theme.fg("error", `Riker: ${String(message.content)}`), 1, 0));
    return box;
  });

  let panelOpen = false;
  let panelRendered = false;

  const updatePanel = (ctx: ExtensionContext) => {
    if (!input.readSessionData) return;
    if (!panelOpen) {
      if (panelRendered) {
        ctx.ui.setWidget("riker-session", undefined);
        panelRendered = false;
      }
      return;
    }
    const snapshot = input.readSessionData();
    ctx.ui.setWidget("riker-session", (_tui, theme) => {
      const box = new Box(0, 0);
      for (const line of renderSessionPanel(theme, snapshot)) {
        box.addChild(new Text(line, 1, 0));
      }
      return box;
    });
    panelRendered = true;
  };

  const updateFooter = (ctx: ExtensionContext, nextStatus = status) => {
    status = nextStatus;
    updatePanel(ctx);
    if (!footer || !footerTheme) return;
    footer.setText(
      renderFooter(footerTheme, input.targetProjectPath, status, input.readSessionView(), panelOpen),
    );
    ctx.ui.setTitle(`CMD Riker — ${input.targetProjectPath}`);
  };

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setTitle(`CMD Riker — ${input.targetProjectPath}`);
    ctx.ui.setHeader((_tui, theme) => new Text(
      `${theme.bold(theme.fg("accent", "CMD Riker"))}  ${theme.fg("dim", input.targetProjectPath)}`,
    ));
    ctx.ui.setFooter((_tui, theme) => {
      footerTheme = theme;
      footer = new Text(
        renderFooter(theme, input.targetProjectPath, status, input.readSessionView(), false),
      );
      return footer;
    });
    ctx.ui.setWorkingMessage("Riker arbeitet …");
    for (const entry of input.transcript) {
      send(pi, entry.source === "owner" ? "riker-owner" : "riker-lead", entry.content);
    }
    unsubscribeNotices = input.subscribeNotices?.((content) => {
      send(pi, "riker-lead", content);
      updateFooter(ctx);
    });
    refreshTimer = setInterval(() => updateFooter(ctx), 500);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" as const };
    const ownerInput = event.text.trim();
    if (!ownerInput) return { action: "handled" as const };
    if (event.images?.length) {
      ctx.ui.notify("Bilder sind in Rikers Owner-Gespräch noch nicht angebunden.", "warning");
      return { action: "handled" as const };
    }

    send(pi, "riker-owner", ownerInput);
    updateFooter(ctx, "responding");
    try {
      const response = await input.completeOwnerInput(
        expandSkillInvocation(ownerInput, input.targetProjectPath),
      );
      send(pi, "riker-lead", response.content);
      updateFooter(ctx, "available");
    } catch (error) {
      send(pi, "riker-error", error instanceof Error ? error.message : String(error));
      updateFooter(ctx, "error");
    }
    return { action: "handled" as const };
  });

  pi.registerCommand("riker", {
    description: "Show CMD Riker's authoritative Session View",
    handler: async (_args, ctx) => {
      ctx.ui.notify(input.readSessionView(), "info");
    },
  });

  pi.registerCommand("view", {
    description: "Toggle the Session View panel (shift+left / shift+right)",
    handler: async (_args, ctx) => {
      panelOpen = !panelOpen;
      updateFooter(ctx);
    },
  });

  pi.registerShortcut("shift+left", {
    description: "Open the Session View panel",
    handler: async (ctx) => {
      if (panelOpen) return;
      panelOpen = true;
      updateFooter(ctx);
    },
  });

  pi.registerShortcut("shift+right", {
    description: "Close the Session View panel",
    handler: async (ctx) => {
      if (!panelOpen) return;
      panelOpen = false;
      updateFooter(ctx);
    },
  });

  pi.registerCommand("workers", {
    description: "Inspect CMD Riker Worker Sessions",
    handler: async (_args, ctx) => {
      const response = await input.completeOwnerInput("/session workers");
      ctx.ui.notify(response.content, "info");
    },
  });

  pi.registerCommand("items", {
    description: "Show every work item and its plain status",
    handler: async (_args, ctx) => {
      const response = await input.completeOwnerInput("/session items");
      ctx.ui.notify(response.content, "info");
    },
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    unsubscribeNotices?.();
    unsubscribeNotices = undefined;
    footer = undefined;
    footerTheme = undefined;
  });
}

function send(pi: ExtensionAPI, customType: string, content: string): void {
  pi.sendMessage({ customType, content, display: true });
}

// Pi expands /skill: invocations only after the input event, so the Owner
// extension resolves the same installed skills itself before the Lead turn.
export function expandSkillInvocation(ownerInput: string, targetProjectPath: string): string {
  if (!ownerInput.startsWith("/skill:")) return ownerInput;
  const spaceIndex = ownerInput.indexOf(" ");
  const skillName = spaceIndex === -1 ? ownerInput.slice(7) : ownerInput.slice(7, spaceIndex);
  const args = spaceIndex === -1 ? "" : ownerInput.slice(spaceIndex + 1).trim();
  let skills;
  try {
    skills = loadSkills({
      cwd: targetProjectPath,
      agentDir: getAgentDir(),
      skillPaths: [],
      includeDefaults: true,
    }).skills;
  } catch {
    return ownerInput;
  }
  const skill = skills.find((candidate) => candidate.name === skillName);
  if (!skill) return ownerInput;
  try {
    const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
    const block =
      `<skill name="${skill.name}" location="${skill.filePath}">\n` +
      `References are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return args ? `${block}\n\n${args}` : block;
  } catch {
    return ownerInput;
  }
}

function renderFooter(
  theme: Theme,
  targetProjectPath: string,
  status: "available" | "responding" | "error",
  sessionView: string,
  panelOpen: boolean,
): string {
  const label = status === "available"
    ? theme.fg("success", "● bereit")
    : status === "responding"
    ? theme.fg("accent", "● arbeitet")
    : theme.fg("error", "● Fehler");
  const compactView = sessionView.replace(/\s+/g, " ").trim();
  const hint = panelOpen ? "shift+→ Session-View zu" : "shift+← Session-View";
  return `${label}  ${theme.fg("dim", compactView || targetProjectPath)}  ${theme.fg("dim", hint)}`;
}

export function formatAge(fromIso: string, now = Date.now()): string {
  const elapsedMs = now - Date.parse(fromIso);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "unter 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function truncate(text: string, maximum: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

export function renderSessionPanel(
  theme: Theme,
  snapshot: SessionViewSnapshot | undefined,
  now = Date.now(),
): string[] {
  const lines: string[] = [theme.bold(theme.fg("accent", "Session View"))];
  if (!snapshot) {
    lines.push(theme.fg("dim", "Noch keine Session-Daten vom Lead."));
    return lines;
  }
  if (snapshot.items.length === 0) {
    lines.push(theme.fg("dim", "Keine Work Items."));
  }
  const workersByItem = new Map<string, SessionViewSnapshot["workers"]>();
  const unattachedWorkers: SessionViewSnapshot["workers"] = [];
  for (const worker of snapshot.workers) {
    if (worker.workItemId) {
      const list = workersByItem.get(worker.workItemId) ?? [];
      list.push(worker);
      workersByItem.set(worker.workItemId, list);
    } else {
      unattachedWorkers.push(worker);
    }
  }
  const workerLine = (worker: SessionViewSnapshot["workers"][number]): string => {
    const age = worker.startedAt ? formatAge(worker.startedAt, now) : "";
    return (
      "  " +
      theme.fg("accent", "⚙ ") +
      theme.fg("dim", `${worker.status} · `) +
      truncate(worker.label, 56) +
      (age ? theme.fg("dim", ` · seit ${age}`) : "")
    );
  };
  for (const item of snapshot.items) {
    const marker = item.needsOwner
      ? theme.fg("error", "● ")
      : item.status.startsWith("done")
        ? theme.fg("success", "● ")
        : theme.fg("accent", "● ");
    const age = item.since ? formatAge(item.since, now) : "";
    lines.push(
      marker +
        truncate(item.outcome, 60) +
        theme.fg("dim", `  ${item.status}${age ? ` · seit ${age}` : ""}`),
    );
    if (item.detail && item.needsOwner) {
      lines.push("  " + theme.fg("dim", truncate(item.detail, 76)));
    }
    for (const worker of workersByItem.get(item.workItemId) ?? []) {
      lines.push(workerLine(worker));
    }
  }
  for (const worker of unattachedWorkers) lines.push(workerLine(worker));
  for (const notice of snapshot.notices) {
    lines.push(theme.fg("error", "! ") + truncate(notice, 76));
  }
  return lines;
}
