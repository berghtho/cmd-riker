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

  const updateFooter = (ctx: ExtensionContext, nextStatus = status) => {
    status = nextStatus;
    if (!footer || !footerTheme) return;
    footer.setText(renderFooter(footerTheme, input.targetProjectPath, status, input.readSessionView()));
    ctx.ui.setTitle(`CMD Riker — ${input.targetProjectPath}`);
  };

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setTitle(`CMD Riker — ${input.targetProjectPath}`);
    ctx.ui.setHeader((_tui, theme) => new Text(
      `${theme.bold(theme.fg("accent", "CMD Riker"))}  ${theme.fg("dim", input.targetProjectPath)}`,
    ));
    ctx.ui.setFooter((_tui, theme) => {
      footerTheme = theme;
      footer = new Text(renderFooter(theme, input.targetProjectPath, status, input.readSessionView()));
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

  pi.registerCommand("workers", {
    description: "Inspect CMD Riker Worker Sessions",
    handler: async (_args, ctx) => {
      const response = await input.completeOwnerInput("/session workers");
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
): string {
  const label = status === "available"
    ? theme.fg("success", "● bereit")
    : status === "responding"
    ? theme.fg("accent", "● arbeitet")
    : theme.fg("error", "● Fehler");
  const compactView = sessionView.replace(/\s+/g, " ").trim();
  return `${label}  ${theme.fg("dim", compactView || targetProjectPath)}`;
}
