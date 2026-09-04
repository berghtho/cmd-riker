import { readFileSync } from "node:fs";

import {
  getAgentDir,
  getMarkdownTheme,
  loadSkills,
  stripFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";

import {
  activityShortcut,
  closeSurfaceShortcut,
  formatAge,
  openSessionsShortcut,
  OwnerSurface,
  renderDecisionDock,
  renderOperationsPanel,
  renderQuietFooter,
  renderSessionNavigation,
  renderUpdateNotice,
  type OwnerSurfaceUpdateStatus,
} from "./owner-surface/index.ts";
import type { SessionViewSnapshot } from "./session-view/index.ts";

// Pi intentionally does not export its CLI composition root. CMD Riker pins the
// package version and uses that root so Pi owns terminal lifecycle and input.
import { main as runPi } from "../node_modules/@earendil-works/pi-coding-agent/dist/main.js";

export type PiOwnerTranscriptEntry = {
  source: "owner" | "lead-agent";
  content: string;
};

export type PiOwnerResponse = {
  source: "Lead Agent" | "Session View";
  content: string;
  /** Direct in-process clients restart after an Owner Session replacement. */
  reattach?: true;
};

export type PiOwnerUpdateStatus = OwnerSurfaceUpdateStatus;

export type PiOwnerInterfaceInput = {
  targetProjectPath: string;
  transcript: PiOwnerTranscriptEntry[];
  completeOwnerInput(ownerInput: string): Promise<PiOwnerResponse>;
  readSessionView(): string;
  readSessionData?(): SessionViewSnapshot | undefined;
  readUpdateStatus?(): PiOwnerUpdateStatus | undefined;
  subscribeNotices?(listener: (content: string) => void): () => void;
  subscribeConversationReplacements?(listener: () => void): () => void;
};

export async function runPiOwnerInterface(
  input: PiOwnerInterfaceInput,
): Promise<"closed" | "conversation-replaced"> {
  const previousDirectory = process.cwd();
  let conversationReplaced = false;
  const replacement = { requested: false };
  const wrappedInput: PiOwnerInterfaceInput = input.subscribeConversationReplacements
    ? {
        ...input,
        subscribeConversationReplacements(listener) {
          return input.subscribeConversationReplacements!(() => {
            conversationReplaced = true;
            listener();
          });
        },
      }
    : input;
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
      extensionFactories: [rikerOwnerExtension(wrappedInput, replacement)],
    });
    return conversationReplaced || replacement.requested
      ? "conversation-replaced"
      : "closed";
  } finally {
    process.chdir(previousDirectory);
  }
}

export function rikerOwnerExtension(
  input: PiOwnerInterfaceInput,
  replacement = { requested: false },
): InlineExtension {
  return {
    name: "CMD Riker",
    hidden: true,
    factory(pi) {
      installRikerOwnerExtension(pi, input, replacement);
    },
  };
}

function installRikerOwnerExtension(
  pi: ExtensionAPI,
  input: PiOwnerInterfaceInput,
  replacement: { requested: boolean },
): void {
  const surface = new OwnerSurface({
    targetProjectPath: input.targetProjectPath,
    readSessionData: () => input.readSessionData?.(),
    ...(input.readUpdateStatus ? { readUpdateStatus: input.readUpdateStatus } : {}),
  });
  let refreshTimer: NodeJS.Timeout | undefined;
  let unsubscribeNotices: (() => void) | undefined;
  let unsubscribeConversationReplacements: (() => void) | undefined;
  let requestRender: (() => void) | undefined;

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

  const updateUi = (ctx: ExtensionContext, status?: "available" | "responding" | "error") => {
    if (status) surface.setStatus(status);
    ctx.ui.setTitle(surface.title());
    requestRender?.();
  };

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setTitle(surface.title());
    ctx.ui.setHeader((_tui, theme) => new SurfaceText(theme, (activeTheme) => surface.header(activeTheme)));
    ctx.ui.setFooter((tui, theme) => {
      requestRender = () => tui.requestRender();
      return new SurfaceText(theme, (activeTheme) => surface.footer(activeTheme));
    });
    ctx.ui.setWidget(
      "riker-owner-surface",
      (tui, theme) => {
        requestRender = () => tui.requestRender();
        return new SurfaceContent(theme, surface);
      },
      { placement: "aboveEditor" },
    );
    ctx.ui.setWorkingMessage("Riker arbeitet …");
    for (const entry of input.transcript) {
      send(pi, entry.source === "owner" ? "riker-owner" : "riker-lead", entry.content);
    }
    unsubscribeNotices = input.subscribeNotices?.((content) => {
      send(pi, "riker-lead", content);
      updateUi(ctx);
    });
    unsubscribeConversationReplacements = input.subscribeConversationReplacements?.(() => {
      replacement.requested = true;
      ctx.shutdown();
    });
    refreshTimer = setInterval(() => updateUi(ctx), 1_000);
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
    updateUi(ctx, "responding");
    try {
      const response = await input.completeOwnerInput(expandSkillInvocation(ownerInput, input.targetProjectPath));
      send(pi, "riker-lead", response.content);
      updateUi(ctx, "available");
      if (response.reattach) {
        replacement.requested = true;
        ctx.shutdown();
      }
    } catch (error) {
      send(pi, "riker-error", error instanceof Error ? error.message : String(error));
      updateUi(ctx, "error");
    }
    return { action: "handled" as const };
  });

  pi.registerCommand("riker", {
    description: "Show CMD Riker's observational Session View",
    handler: async (_args, ctx) => ctx.ui.notify(input.readSessionView(), "info"),
  });
  pi.registerCommand("view", {
    description: `Toggle Activity (${activityShortcut})`,
    handler: async (_args, ctx) => {
      surface.toggleActivity();
      updateUi(ctx);
    },
  });
  pi.registerCommand("details", {
    description: "Toggle Worker, Model and Standing Order details",
    handler: async (_args, ctx) => {
      surface.toggleDetails();
      updateUi(ctx);
    },
  });
  pi.registerCommand("history", {
    description: "Toggle completed work and previous sessions",
    handler: async (_args, ctx) => {
      surface.toggleHistory();
      updateUi(ctx);
    },
  });
  pi.registerShortcut(activityShortcut, {
    description: "Toggle CMD Riker Activity",
    handler: async (ctx) => {
      surface.toggleActivity();
      updateUi(ctx);
    },
  });
  pi.registerShortcut(openSessionsShortcut, {
    description: "Open CMD Riker session navigation",
    handler: async (ctx) => {
      surface.openSessions();
      updateUi(ctx);
    },
  });
  pi.registerShortcut(closeSurfaceShortcut, {
    description: "Close CMD Riker inline surface",
    handler: async (ctx) => {
      surface.close();
      updateUi(ctx);
    },
  });
  for (const [command, request, description] of [
    ["workers", "/session workers", "Inspect CMD Riker Worker Sessions"],
    ["items", "/session items", "Show current work items; /history for completed work"],
    ["orders", "/session orders", "Show Standing Orders"],
    ["sessions", "/session list", "List Owner Sessions"],
  ] as const) {
    pi.registerCommand(command, {
      description,
      handler: async (_args, ctx) => {
        const response = await input.completeOwnerInput(request);
        ctx.ui.notify(response.content, "info");
      },
    });
  }

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    unsubscribeNotices?.();
    unsubscribeNotices = undefined;
    unsubscribeConversationReplacements?.();
    unsubscribeConversationReplacements = undefined;
    requestRender = undefined;
  });
}

class SurfaceText extends Text {
  private readonly theme: Theme;
  private readonly readText: (theme: Theme) => string;

  constructor(theme: Theme, readText: (theme: Theme) => string) {
    super(readText(theme));
    this.theme = theme;
    this.readText = readText;
  }

  override render(width: number): string[] {
    this.setText(truncateToWidth(this.readText(this.theme), width));
    return super.render(width);
  }
}

class SurfaceContent {
  private readonly theme: Theme;
  private readonly surface: OwnerSurface;

  constructor(theme: Theme, surface: OwnerSurface) {
    this.theme = theme;
    this.surface = surface;
  }
  render(width: number): string[] {
    return this.surface.content(this.theme, width);
  }
  invalidate(): void {}
}

function send(pi: ExtensionAPI, customType: string, content: string): void {
  pi.sendMessage({ customType, content, display: true });
}

export function expandSkillInvocation(ownerInput: string, targetProjectPath: string): string {
  if (!ownerInput.startsWith("/skill:")) return ownerInput;
  const spaceIndex = ownerInput.indexOf(" ");
  const skillName = spaceIndex === -1 ? ownerInput.slice(7) : ownerInput.slice(7, spaceIndex);
  const args = spaceIndex === -1 ? "" : ownerInput.slice(spaceIndex + 1).trim();
  let skills;
  try {
    skills = loadSkills({ cwd: targetProjectPath, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true }).skills;
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

export {
  formatAge,
  renderDecisionDock,
  renderOperationsPanel,
  renderQuietFooter,
  renderSessionNavigation,
  renderUpdateNotice,
};
