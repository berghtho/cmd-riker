import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export interface CommandRunner {
  run(executable: string, arguments_: readonly string[]): Promise<CommandResult>;
}

export class NativeCommandRunner implements CommandRunner {
  run(executable: string, arguments_: readonly string[]): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        executable,
        [...arguments_],
        {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          shell: false,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: typeof error?.code === "number" ? error.code : error ? -1 : 0,
            stdout,
            stderr: stderr || error?.message || "",
          });
        },
      );
    });
  }
}

export type WindowsSupervisionPolicy = {
  restartCount: number;
  restartIntervalMinutes: number;
};

export type WindowsSupervisionConfig = {
  taskName: string;
  currentUserId: string;
  executable: string;
  arguments: string;
  policy: WindowsSupervisionPolicy;
};

export type WindowsSupervisionInspection = {
  xml: string;
  userId: string;
  logonType: string;
  runLevel: string;
  actionContext: string;
  command: string;
  arguments: string;
  actionType: string;
  multipleInstancesPolicy: string;
  restartCount: number;
  restartIntervalMinutes: number;
  allowStartOnDemand: boolean;
  enabled: boolean;
  hasTriggers: boolean;
  disallowStartIfOnBatteries: boolean;
  stopIfGoingOnBatteries: boolean;
  runOnlyIfIdle: boolean;
  stopOnIdleEnd: boolean;
  restartOnIdle: boolean;
  executionTimeLimit: string;
};

type SupervisionOperation =
  | "register"
  | "start"
  | "stop"
  | "disable"
  | "unregister"
  | "inspect"
  | "verify";

export class WindowsSupervisionError extends Error {
  readonly operation: SupervisionOperation;
  readonly exitCode: number | undefined;

  constructor(
    operation: SupervisionOperation,
    message: string,
    exitCode?: number,
  ) {
    super(message);
    this.name = "WindowsSupervisionError";
    this.operation = operation;
    this.exitCode = exitCode;
  }
}

export function generateWindowsTaskXml(config: WindowsSupervisionConfig): string {
  validateConfig(config);
  const userId = escapeXml(config.currentUserId);
  const command = escapeXml(config.executable);
  const arguments_ = escapeXml(config.arguments);
  const interval = config.policy.restartIntervalMinutes;

  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Supervises the protected CMD Riker Recovery Actor.</Description>",
    "  </RegistrationInfo>",
    "  <Triggers />",
    "  <Principals>",
    '    <Principal id="CurrentUser">',
    `      <UserId>${userId}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>false</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "    <RestartOnFailure>",
    `      <Interval>PT${interval}M</Interval>`,
    `      <Count>${config.policy.restartCount}</Count>`,
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="CurrentUser">',
    "    <Exec>",
    `      <Command>${command}</Command>`,
    `      <Arguments>${arguments_}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

export class WindowsTaskSchedulerSupervision {
  readonly #config: WindowsSupervisionConfig;
  readonly #runner: CommandRunner;

  constructor(config: WindowsSupervisionConfig, runner: CommandRunner = new NativeCommandRunner()) {
    validateConfig(config);
    this.#config = {
      ...config,
      policy: { ...config.policy },
    };
    this.#runner = runner;
  }

  async register(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "cmd-riker-task-"));
    const xmlPath = join(directory, "recovery-actor.xml");
    try {
      await writeFile(
        xmlPath,
        Buffer.from(`\uFEFF${generateWindowsTaskXml(this.#config)}`, "utf16le"),
      );
      await this.#run("register", ["/Create", "/TN", this.#config.taskName, "/XML", xmlPath, "/F"]);
    } catch (error) {
      throw operationError("register", error);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  async start(): Promise<void> {
    await this.#run("start", ["/Run", "/TN", this.#config.taskName]);
  }

  async stop(): Promise<void> {
    await this.#run("stop", ["/End", "/TN", this.#config.taskName]);
  }

  async disable(): Promise<void> {
    await this.#run("disable", ["/Change", "/TN", this.#config.taskName, "/Disable"]);
  }

  async unregister(): Promise<void> {
    await this.#run("unregister", ["/Delete", "/TN", this.#config.taskName, "/F"]);
  }

  async inspect(): Promise<WindowsSupervisionInspection> {
    const result = await this.#run("inspect", ["/Query", "/TN", this.#config.taskName, "/XML"]);
    try {
      return inspectWindowsTaskXml(result.stdout);
    } catch (error) {
      throw operationError("inspect", error);
    }
  }

  async verify(): Promise<WindowsSupervisionInspection> {
    let inspection: WindowsSupervisionInspection;
    try {
      inspection = await this.inspect();
    } catch (error) {
      if (error instanceof WindowsSupervisionError) {
        throw new WindowsSupervisionError(
          "verify",
          `Task Scheduler verification failed: ${error.message}`,
          error.exitCode,
        );
      }
      throw operationError("verify", error);
    }

    const expected = this.#config;
    const mismatches: string[] = [];
    check(mismatches, "current-user identity", inspection.userId, expected.currentUserId);
    check(mismatches, "logon type", inspection.logonType, "InteractiveToken");
    check(mismatches, "run level", inspection.runLevel, "LeastPrivilege");
    check(mismatches, "action context", inspection.actionContext, "CurrentUser");
    check(mismatches, "action type", inspection.actionType, "Exec");
    check(mismatches, "executable", inspection.command, expected.executable);
    check(mismatches, "arguments", inspection.arguments, expected.arguments);
    check(mismatches, "multiple-instance policy", inspection.multipleInstancesPolicy, "IgnoreNew");
    check(mismatches, "restart count", inspection.restartCount, expected.policy.restartCount);
    check(
      mismatches,
      "restart interval",
      inspection.restartIntervalMinutes,
      expected.policy.restartIntervalMinutes,
    );
    check(mismatches, "on-demand start", inspection.allowStartOnDemand, true);
    check(mismatches, "enabled state", inspection.enabled, true);
    check(mismatches, "triggers", inspection.hasTriggers, false);
    check(mismatches, "battery start restriction", inspection.disallowStartIfOnBatteries, false);
    check(mismatches, "battery stop restriction", inspection.stopIfGoingOnBatteries, false);
    check(mismatches, "idle-only restriction", inspection.runOnlyIfIdle, false);
    check(mismatches, "stop on idle end", inspection.stopOnIdleEnd, false);
    check(mismatches, "restart on idle", inspection.restartOnIdle, false);
    check(mismatches, "execution time limit", inspection.executionTimeLimit, "PT0S");

    if (mismatches.length > 0) {
      throw new WindowsSupervisionError(
        "verify",
        `Task Scheduler verification failed: ${mismatches.join("; ")}.`,
      );
    }
    return inspection;
  }

  async #run(operation: SupervisionOperation, arguments_: readonly string[]): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await this.#runner.run("schtasks.exe", arguments_);
    } catch (error) {
      throw operationError(operation, error);
    }
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim() || "no diagnostic output";
      throw new WindowsSupervisionError(
        operation,
        `Task Scheduler ${operation} failed with exit code ${result.exitCode}: ${detail}`,
        result.exitCode,
      );
    }
    return result;
  }
}

export function createWindowsSupervision(
  config: WindowsSupervisionConfig,
  runner?: CommandRunner,
): WindowsTaskSchedulerSupervision {
  return new WindowsTaskSchedulerSupervision(config, runner);
}

export function inspectWindowsTaskXml(xml: string): WindowsSupervisionInspection {
  const triggers = element(xml, "Triggers");
  const restartInterval = requiredText(xml, "Interval");
  const intervalMatch = /^PT([1-9]\d*)M$/.exec(restartInterval);
  if (!intervalMatch?.[1]) {
    throw new Error(`invalid RestartOnFailure interval ${JSON.stringify(restartInterval)}`);
  }
  const actionBody = element(xml, "Actions");
  const execActions = matchingElements(actionBody, "Exec");
  if (execActions.length !== 1) {
    throw new Error(`expected exactly one Exec action, found ${execActions.length}`);
  }
  const execAction = execActions[0];
  if (!execAction) throw new Error("missing Exec action");
  const otherActions = stripXmlComments(actionBody.replace(execAction, "")).trim();
  if (otherActions) throw new Error("expected the Exec action to be the only task action");
  const actions = requiredOpeningTag(xml, "Actions");

  return {
    xml,
    userId: requiredText(xml, "UserId"),
    logonType: requiredText(xml, "LogonType"),
    runLevel: optionalText(xml, "RunLevel") || "LeastPrivilege",
    actionContext: requiredAttribute(actions, "Context"),
    command: requiredText(execAction, "Command"),
    arguments: optionalText(execAction, "Arguments"),
    actionType: "Exec",
    multipleInstancesPolicy: requiredText(xml, "MultipleInstancesPolicy"),
    restartCount: requiredInteger(xml, "Count"),
    restartIntervalMinutes: Number(intervalMatch[1]),
    allowStartOnDemand: optionalBoolean(xml, "AllowStartOnDemand", true),
    enabled: optionalBoolean(xml, "Enabled", true),
    hasTriggers: stripXmlComments(triggers).trim().length > 0,
    disallowStartIfOnBatteries: requiredBoolean(xml, "DisallowStartIfOnBatteries"),
    stopIfGoingOnBatteries: requiredBoolean(xml, "StopIfGoingOnBatteries"),
    runOnlyIfIdle: optionalBoolean(xml, "RunOnlyIfIdle", false),
    stopOnIdleEnd: requiredBoolean(xml, "StopOnIdleEnd"),
    restartOnIdle: requiredBoolean(xml, "RestartOnIdle"),
    executionTimeLimit: requiredText(xml, "ExecutionTimeLimit"),
  };
}

function validateConfig(config: WindowsSupervisionConfig): void {
  requiredConfigText("taskName", config.taskName);
  requiredConfigText("currentUserId", config.currentUserId);
  requiredConfigText("executable", config.executable);
  if (config.arguments.includes("\0")) {
    throw new TypeError("Windows supervision arguments must not contain NUL characters.");
  }
  integerInRange("restartCount", config.policy.restartCount, 1, 999);
  integerInRange("restartIntervalMinutes", config.policy.restartIntervalMinutes, 1, 44_640);
}

function requiredConfigText(name: string, value: string): void {
  if (!value.trim() || value.includes("\0")) {
    throw new TypeError(`Windows supervision ${name} must be a non-empty NUL-free string.`);
  }
}

function integerInRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `Windows supervision ${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function element(xml: string, name: string): string {
  const paired = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>`,
    "i",
  ).exec(xml);
  if (paired?.[1] !== undefined) return paired[1];
  const empty = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*/\\s*>`, "i").test(xml);
  if (empty) return "";
  throw new Error(`missing ${name} element`);
}

function matchingElements(xml: string, name: string): string[] {
  const pattern = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*>[\\s\\S]*?<\\/(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>`,
    "gi",
  );
  return [...xml.matchAll(pattern)].map((match) => match[0]);
}

function requiredText(xml: string, name: string, allowEmpty = false): string {
  const value = decodeXml(element(xml, name).trim());
  if (!allowEmpty && !value) throw new Error(`empty ${name} element`);
  return value;
}

function optionalText(xml: string, name: string): string {
  try {
    return requiredText(xml, name, true);
  } catch (error) {
    if (error instanceof Error && error.message === `missing ${name} element`) return "";
    throw error;
  }
}

function requiredInteger(xml: string, name: string): number {
  const value = requiredText(xml, name);
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${name} integer ${JSON.stringify(value)}`);
  return Number(value);
}

function requiredBoolean(xml: string, name: string): boolean {
  const value = requiredText(xml, name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid ${name} boolean ${JSON.stringify(value)}`);
}

function optionalBoolean(xml: string, name: string, defaultValue: boolean): boolean {
  try {
    return requiredBoolean(xml, name);
  } catch (error) {
    if (error instanceof Error && error.message === `missing ${name} element`) {
      return defaultValue;
    }
    throw error;
  }
}

function requiredOpeningTag(xml: string, name: string): string {
  const match = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*>`, "i").exec(xml);
  if (!match) throw new Error(`missing ${name} element`);
  return match[0];
}

function requiredAttribute(openingTag: string, name: string): string {
  const match = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(openingTag);
  if (match?.[2] === undefined) throw new Error(`missing ${name} attribute`);
  return decodeXml(match[2]);
}

function stripXmlComments(xml: string): string {
  return xml.replaceAll(/<!--[\s\S]*?-->/g, "");
}

function check(
  mismatches: string[],
  label: string,
  actual: string | number | boolean,
  expected: string | number | boolean,
): void {
  if (actual !== expected) {
    mismatches.push(`${label} expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

function operationError(operation: SupervisionOperation, error: unknown): WindowsSupervisionError {
  if (error instanceof WindowsSupervisionError && error.operation === operation) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new WindowsSupervisionError(
    operation,
    `Task Scheduler ${operation} failed: ${detail || "unknown error"}`,
  );
}
