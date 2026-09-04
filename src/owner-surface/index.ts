import { basename } from "node:path";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import { renderLeadTurnMetrics, type SessionViewSnapshot } from "../session-view/index.ts";
import { groupOperatorItems } from "../session-view/operator-items.ts";

export const activityShortcut = "alt+a" as const;
export const openSessionsShortcut = "shift+left" as const;
export const closeSurfaceShortcut = "shift+right" as const;

export type OwnerSurfaceStatus = "available" | "responding" | "error";
export type OwnerSurfaceMode = "quiet" | "activity" | "sessions" | "details" | "history";

export type OwnerSurfaceUpdateStatus = {
  installedRevision: string;
  installedCommit: string;
  repositoryCommit: string;
  updateAvailable: boolean;
};

export type OwnerSurfaceInput = {
  targetProjectPath: string;
  readSessionData(): SessionViewSnapshot | undefined;
  readUpdateStatus?(): OwnerSurfaceUpdateStatus | undefined;
};

/**
 * Owns the complete display state for Riker's Pi shell. Pi only mounts the
 * returned header, footer and bounded inline content; it never owns Riker's
 * navigation state or enters a custom full-screen UI mode.
 */
export class OwnerSurface {
  private mode: OwnerSurfaceMode = "quiet";
  private status: OwnerSurfaceStatus = "available";
  private readonly input: OwnerSurfaceInput;

  constructor(input: OwnerSurfaceInput) {
    this.input = input;
  }

  setStatus(status: OwnerSurfaceStatus): void {
    this.status = status;
  }

  toggleActivity(): void {
    this.mode = this.mode === "activity" ? "quiet" : "activity";
  }

  openSessions(): void {
    this.mode = "sessions";
  }

  toggleDetails(): void {
    this.mode = this.mode === "details" ? "quiet" : "details";
  }

  toggleHistory(): void {
    this.mode = this.mode === "history" ? "quiet" : "history";
  }

  close(): void {
    this.mode = "quiet";
  }

  currentMode(): OwnerSurfaceMode {
    return this.mode;
  }

  title(): string {
    return `CMD Riker — ${this.input.targetProjectPath}`;
  }

  header(theme: Theme): string {
    const current = this.input.readSessionData()?.sessions?.find((session) => session.current);
    const session = current?.name ? `  ${theme.fg("dim", current.name)}` : "";
    return (
      `${theme.bold(theme.fg("accent", "CMD Riker"))}  ` +
      `${theme.fg("dim", basename(this.input.targetProjectPath))}${session}`
    );
  }

  footer(theme: Theme): string {
    return renderQuietFooter(
      theme,
      this.status,
      this.input.readSessionData(),
      this.mode,
      this.input.readUpdateStatus?.(),
    );
  }

  content(theme: Theme, width: number, now = Date.now()): string[] {
    const snapshot = this.input.readSessionData();
    if (this.mode === "quiet") return renderDecisionDock(theme, snapshot, width);
    const usable = Math.max(20, width);
    const lines = this.mode === "activity"
      ? renderOperationsPanel(theme, snapshot, now, usable)
      : this.mode === "history"
      ? renderHistory(theme, snapshot)
      : this.mode === "details"
      ? renderDetails(theme, snapshot)
      : renderSessionNavigation(theme, snapshot, usable);
    const update = this.input.readUpdateStatus?.();
    if (update?.updateAvailable) {
      lines.push(theme.fg("accent", `⬆ ${renderUpdateNotice(update)}`));
    }
    const maximumBodyLines = 7;
    const body = lines.length <= maximumBodyLines
      ? lines
      : [
          ...lines.slice(0, maximumBodyLines - 1),
          theme.fg("dim", `… ${lines.length - maximumBodyLines + 1} weitere Zeilen`),
        ];
    const hint = this.mode === "activity"
      ? `${activityShortcut} schließen · /items alle aktuellen · /details · /history`
      : this.mode === "history"
      ? `${closeSurfaceShortcut} schließen · /session history alle · /sessions`
      : this.mode === "details"
      ? `${closeSurfaceShortcut} schließen · /workers · /orders`
      : `${closeSurfaceShortcut} schließen · /session use N · /session new [Projekt]`;
    body.push(theme.fg("dim", hint));
    return body.map((line) => truncateToWidth(line, usable));
  }
}

export function renderQuietFooter(
  theme: Theme,
  status: OwnerSurfaceStatus,
  snapshot: SessionViewSnapshot | undefined,
  mode: OwnerSurfaceMode,
  update: OwnerSurfaceUpdateStatus | undefined,
): string {
  const label = status === "available"
    ? theme.fg("success", "● bereit")
    : status === "responding"
    ? theme.fg("accent", "● arbeitet")
    : theme.fg("error", "● Fehler");
  const signals: string[] = [];
  if (snapshot?.activeWorkerCount) signals.push(theme.fg("dim", `${snapshot.activeWorkerCount} Worker`));
  const decisions = snapshot?.items.filter((item) => item.needsOwner).length ?? 0;
  if (decisions > 0) signals.push(theme.fg("warning", ownerDecisionCount(decisions)));
  else if (snapshot?.notices.length) {
    const count = snapshot.notices.length;
    signals.push(theme.fg("dim", `${count} ${count === 1 ? "Hinweis" : "Hinweise"}`));
  }
  const summary = signals.length > 0 ? `  ${signals.join(theme.fg("dim", " · "))}` : "";
  const hint = mode === "activity"
    ? `${activityShortcut} schließen`
    : mode !== "quiet"
    ? `${closeSurfaceShortcut} schließen`
    : `${activityShortcut} Aktivität · ${openSessionsShortcut} Sessions`;
  const updateHint = update?.updateAvailable
    ? `  ${theme.fg("accent", `⬆ ${renderUpdateNotice(update)}`)}`
    : "";
  return `${label}${summary}  ${theme.fg("dim", hint)}${updateHint}`;
}

export function renderDecisionDock(
  theme: Theme,
  snapshot: SessionViewSnapshot | undefined,
  width = 80,
): string[] {
  const decision = snapshot?.items.find((item) => item.needsOwner);
  if (!decision) {
    const concern = snapshot ? groupOperatorItems(snapshot.items).attention[0] : undefined;
    const notice = snapshot?.notices[0];
    if (!concern && !notice) return [];
    return [
      theme.fg("warning", "◆ Hinweis"),
      truncateToWidth(concern?.outcome ?? notice!, width),
      ...(concern?.detail ? [truncateToWidth(concern.detail, width)] : []),
      theme.fg("dim", `${activityShortcut} Aktivität · /riker Hinweise · /items`),
    ];
  }
  const available = Math.max(24, width - 2);
  const hasOtherWork = snapshot?.workers.some(
    (worker) => !worker.workItemId || worker.workItemId !== decision.workItemId,
  );
  const continuation = hasOtherWork ? " · andere Arbeit läuft weiter" : "";
  const [context, recommendation] = splitDecisionDetail(decision.detail);
  const lines = [
    theme.fg("warning", `◆ Deine Entscheidung${continuation}`),
    theme.bold(truncate(decision.outcome, available)),
  ];
  if (context) lines.push(theme.fg("dim", `  Kontext: ${truncate(context, available - 2)}`));
  if (recommendation) {
    lines.push(theme.fg("accent", `  Empfehlung: ${truncate(recommendation, available - 2)}`));
  }
  lines.push(theme.fg("dim", "  Antworte Riker einfach im Gespräch."));
  return lines.map((line) => truncateToWidth(line, width));
}

export function renderSessionNavigation(
  theme: Theme,
  snapshot: SessionViewSnapshot | undefined,
  width = 80,
): string[] {
  const lines = [theme.bold(theme.fg("accent", "Session-Navigation"))];
  if (!snapshot) {
    lines.push(theme.fg("dim", "Noch keine Session-Daten vom Lead."));
    return lines;
  }
  const sessions = (snapshot.sessions ?? []).filter((session) => session.current || session.state === "active")
    .sort((left, right) => Number(right.current) - Number(left.current));
  if (sessions.length === 0) lines.push(theme.fg("dim", "Keine Sessions · /session new"));
  for (const session of sessions.slice(0, 5)) {
    const label = `${session.project ? `[${session.project}] ` : ""}${session.name || "(unbenannt)"}`;
    lines.push(session.current
      ? theme.fg("accent", "● ") + theme.bold(truncate(label, width - 2))
      : theme.fg("dim", `○ ${truncate(label, Math.max(18, width - 22))} · /session use ${session.number}`));
  }
  if (sessions.length > 5) lines.push(theme.fg("dim", `… ${sessions.length - 5} weitere · /sessions`));
  if ((snapshot.projects?.length ?? 0) > 1) {
    lines.push(theme.fg("dim", `${snapshot.projects!.length} Projekte · /session projects`));
  }
  return lines;
}

export function renderUpdateNotice(update: OwnerSurfaceUpdateStatus): string {
  return (
    `neue Version im Repo (${update.repositoryCommit.slice(0, 7)}; ` +
    `installiert ${update.installedRevision} @ ${update.installedCommit.slice(0, 7)}) — riker upgrade`
  );
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

export function renderOperationsPanel(
  theme: Theme,
  snapshot: SessionViewSnapshot | undefined,
  now = Date.now(),
  contentWidth = 96,
): string[] {
  const width = Math.max(20, contentWidth);
  const lines = [theme.bold(theme.fg("accent", "Aktivität"))];
  if (!snapshot) return [...lines, theme.fg("dim", "Noch keine Session-Daten vom Lead.")];
  const { attention, active } = groupOperatorItems(snapshot.items);
  const current = [...attention, ...active];
  const notices = [...new Set(snapshot.notices)];
  if (notices[0]) lines.push(theme.fg("warning", `! ${truncate(notices[0], width - 2)}`));
  if (notices.length > 1) lines.push(theme.fg("warning", `${notices.length - 1} weitere Hinweise · /riker`));
  if (current.length === 0) lines.push(theme.fg("dim", "Keine laufende Arbeit."));
  for (const item of current.slice(0, 3)) {
    const marker = item.needsOwner ? "◆ " : "● ";
    const age = item.since ? formatAge(item.since, now) : "";
    lines.push(theme.fg(item.needsOwner ? "warning" : "accent", marker + truncate(item.outcome, width - 2)));
    lines.push(theme.fg("dim", `  ${humanItemStatus(item.status)}${age ? ` · ${age}` : ""}`));
  }
  if (current.length > 3) lines.push(theme.fg("dim", `${current.length - 3} weitere aktuelle Aufgaben · /items`));
  if (snapshot.activeWorkerCount > 0) lines.push(theme.fg("dim", `${snapshot.activeWorkerCount} Worker aktiv · /workers`));
  return lines;
}

function renderDetails(theme: Theme, snapshot: SessionViewSnapshot | undefined): string[] {
  const lines = [theme.bold(theme.fg("accent", "Details"))];
  if (!snapshot) return [...lines, theme.fg("dim", "Noch keine Session-Daten vom Lead.")];
  if (snapshot.lead) lines.push(theme.fg("dim", renderLeadTurnMetrics(snapshot.lead)));
  for (const worker of snapshot.workers) {
    lines.push(`${humanWorkerStatus(worker.status)} · ${worker.label}`);
  }
  for (const order of snapshot.standingOrders ?? []) {
    if (order.status === "active") lines.push(`Order: ${order.title}`);
  }
  if (lines.length === 1) lines.push(theme.fg("dim", "Keine weiteren Details."));
  return lines;
}

function renderHistory(theme: Theme, snapshot: SessionViewSnapshot | undefined): string[] {
  const lines = [theme.bold(theme.fg("accent", "History"))];
  if (!snapshot) return [...lines, theme.fg("dim", "Noch keine Session-Daten vom Lead.")];
  const { history } = groupOperatorItems(snapshot.items);
  for (const item of history.slice(-4).reverse()) lines.push(`✓ ${item.outcome}`);
  if (history.length > 4) lines.push(theme.fg("dim", `${history.length - 4} weitere · /session history`));
  const previous = (snapshot.sessions ?? []).filter((session) => !session.current);
  for (const session of previous.slice(0, 2)) lines.push(theme.fg("dim", `Session: ${session.name} · ${session.state}`));
  if (previous.length > 2) lines.push(theme.fg("dim", `${previous.length - 2} weitere Sessions · /sessions`));
  if (lines.length === 1) lines.push(theme.fg("dim", "Noch kein Verlauf."));
  return lines;
}
function splitDecisionDetail(detail: string | undefined): [string | undefined, string | undefined] {
  if (!detail) return [undefined, undefined];
  const separator = detail.lastIndexOf(" Next: ");
  if (separator === -1) return [detail, undefined];
  return [detail.slice(0, separator), detail.slice(separator + " Next: ".length)];
}

function truncate(text: string, maximum: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

function humanItemStatus(status: string): string {
  if (status === "needs you") return "braucht dich";
  if (status.startsWith("in progress")) return "in Arbeit";
  if (status === "verifying the result") return "prüft Ergebnis";
  if (status === "recovering") return "stellt wieder her";
  if (status === "blocked") return "blockiert";
  if (status === "paused") return "pausiert";
  return status;
}

function ownerDecisionCount(count: number): string {
  return `${count} ${count === 1 ? "braucht" : "brauchen"} dich`;
}

function humanWorkerStatus(status: SessionViewSnapshot["workers"][number]["status"]): string {
  if (status === "starting") return "startet";
  if (status === "running") return "arbeitet";
  if (status === "waiting-question") return "wartet auf Antwort";
  if (status === "cancellation-requested") return "wird beendet";
  if (status === "reconciling") return "wird abgeglichen";
  if (status === "completed") return "erledigt";
  if (status === "blocked") return "blockiert";
  if (status === "failed") return "fehlgeschlagen";
  if (status === "cancelled") return "beendet";
  return status;
}
