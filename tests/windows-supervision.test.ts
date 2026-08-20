import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWindowsSupervision,
  generateWindowsTaskXml,
  inspectWindowsTaskXml,
  type CommandResult,
  type CommandRunner,
  type WindowsSupervisionConfig,
  WindowsSupervisionError,
} from "../src/windows-supervision/index.ts";

const config: WindowsSupervisionConfig = {
  taskName: "\\CMD Riker\\Recovery Actor",
  currentUserId: "WORKSTATION\\owner",
  executable: "C:\\Program Files\\CMD Riker\\recovery-actor.exe",
  arguments: '--state "C:\\Users\\owner\\AppData\\Local\\CMD Riker & State" --mode protected',
  policy: {
    restartCount: 4,
    restartIntervalMinutes: 2,
  },
};

type Invocation = {
  executable: string;
  arguments: readonly string[];
  xml?: string;
};

class RecordingRunner implements CommandRunner {
  readonly invocations: Invocation[] = [];
  results: CommandResult[] = [];
  queryXml = generateWindowsTaskXml(config);

  async run(executable: string, arguments_: readonly string[]): Promise<CommandResult> {
    const invocation: Invocation = { executable, arguments: [...arguments_] };
    const xmlIndex = arguments_.indexOf("/XML");
    if (arguments_[0] === "/Create" && xmlIndex >= 0) {
      const xmlPath = arguments_[xmlIndex + 1];
      assert(xmlPath);
      invocation.xml = (await readFile(xmlPath)).toString("utf16le").replace(/^\uFEFF/, "");
    }
    this.invocations.push(invocation);
    return (
      this.results.shift() ?? {
        exitCode: 0,
        stdout: arguments_[0] === "/Query" ? this.queryXml : "SUCCESS",
        stderr: "",
      }
    );
  }
}

test("generates an on-demand current-user task with explicit uninterrupted supervision policy", () => {
  const xml = generateWindowsTaskXml(config);

  assert.match(xml, /<Triggers\s*\/>/);
  assert.doesNotMatch(xml, /BootTrigger|LogonTrigger/);
  assert.match(xml, /<UserId>WORKSTATION\\owner<\/UserId>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<AllowStartOnDemand>true<\/AllowStartOnDemand>/);
  assert.match(xml, /<Interval>PT2M<\/Interval>/);
  assert.match(xml, /<Count>4<\/Count>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<RunOnlyIfIdle>false<\/RunOnlyIfIdle>/);
  assert.match(xml, /<StopOnIdleEnd>false<\/StopOnIdleEnd>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Actions Context="CurrentUser">/);
  assert.match(xml, /<Command>C:\\Program Files\\CMD Riker\\recovery-actor\.exe<\/Command>/);
  assert.match(
    xml,
    /<Arguments>--state &quot;C:\\Users\\owner\\AppData\\Local\\CMD Riker &amp; State&quot; --mode protected<\/Arguments>/,
  );

  const inspection = inspectWindowsTaskXml(xml);
  assert.equal(inspection.command, config.executable);
  assert.equal(inspection.arguments, config.arguments);
  assert.equal(inspection.hasTriggers, false);
  assert.equal(inspection.actionType, "Exec");
});

test("registers through a temporary XML file and controls only the configured task", async () => {
  const runner = new RecordingRunner();
  const supervision = createWindowsSupervision(config, runner);

  await supervision.register();
  await supervision.start();
  await supervision.stop();
  await supervision.disable();
  await supervision.unregister();

  const registration = runner.invocations[0];
  assert(registration);
  assert.equal(registration.executable, "schtasks.exe");
  assert.deepEqual(registration.arguments.slice(0, 4), [
    "/Create",
    "/TN",
    config.taskName,
    "/XML",
  ]);
  assert.equal(registration.arguments.at(-1), "/F");
  assert.equal(registration.xml, generateWindowsTaskXml(config));
  assert.deepEqual(
    runner.invocations.slice(1).map(({ executable, arguments: arguments_ }) => [
      executable,
      ...arguments_,
    ]),
    [
      ["schtasks.exe", "/Run", "/TN", config.taskName],
      ["schtasks.exe", "/End", "/TN", config.taskName],
      ["schtasks.exe", "/Change", "/TN", config.taskName, "/Disable"],
      ["schtasks.exe", "/Delete", "/TN", config.taskName, "/F"],
    ],
  );
});

test("inspect and verify query scheduler XML without changing the task", async () => {
  const runner = new RecordingRunner();
  const supervision = createWindowsSupervision(config, runner);

  const inspection = await supervision.inspect();
  const verified = await supervision.verify();

  assert.equal(inspection.userId, config.currentUserId);
  assert.equal(verified.restartCount, config.policy.restartCount);
  assert.deepEqual(
    runner.invocations.map(({ executable, arguments: arguments_ }) => [executable, ...arguments_]),
    [
      ["schtasks.exe", "/Query", "/TN", config.taskName, "/XML"],
      ["schtasks.exe", "/Query", "/TN", config.taskName, "/XML"],
    ],
  );
});

test("verify rejects policy drift with deterministic details", async () => {
  const runner = new RecordingRunner();
  runner.queryXml = generateWindowsTaskXml(config)
    .replace("<MultipleInstancesPolicy>IgnoreNew", "<MultipleInstancesPolicy>Parallel")
    .replace("<ExecutionTimeLimit>PT0S", "<ExecutionTimeLimit>PT72H");

  await assert.rejects(
    createWindowsSupervision(config, runner).verify(),
    (error: unknown) => {
      assert(error instanceof WindowsSupervisionError);
      assert.equal(error.operation, "verify");
      assert.match(error.message, /multiple-instance policy expected "IgnoreNew", found "Parallel"/);
      assert.match(error.message, /execution time limit expected "PT0S", found "PT72H"/);
      return true;
    },
  );
});

test("inspect rejects an additional action instead of accepting the expected Exec action alone", () => {
  const xml = generateWindowsTaskXml(config).replace(
    "    </Exec>\r\n  </Actions>",
    "    </Exec>\r\n    <ComHandler><ClassId>{00000000-0000-0000-0000-000000000000}</ClassId></ComHandler>\r\n  </Actions>",
  );

  assert.throws(() => inspectWindowsTaskXml(xml), /Exec action to be the only task action/);
});

test("command failures preserve the operation and exit code", async () => {
  const runner = new RecordingRunner();
  runner.results.push({ exitCode: 5, stdout: "", stderr: "Access is denied.\r\n" });

  await assert.rejects(
    createWindowsSupervision(config, runner).start(),
    (error: unknown) => {
      assert(error instanceof WindowsSupervisionError);
      assert.equal(error.operation, "start");
      assert.equal(error.exitCode, 5);
      assert.equal(error.message, "Task Scheduler start failed with exit code 5: Access is denied.");
      return true;
    },
  );
});

test("rejects unbounded or sub-minute restart policy before invoking schtasks", () => {
  const runner = new RecordingRunner();

  assert.throws(
    () =>
      createWindowsSupervision(
        { ...config, policy: { restartCount: 0, restartIntervalMinutes: 1 } },
        runner,
      ),
    /restartCount must be an integer from 1 through 999/,
  );
  assert.throws(
    () =>
      createWindowsSupervision(
        { ...config, policy: { restartCount: 1, restartIntervalMinutes: 0 } },
        runner,
      ),
    /restartIntervalMinutes must be an integer from 1 through 44640/,
  );
  assert.equal(runner.invocations.length, 0);
});

test("real Task Scheduler registration starts one on-demand current-user singleton", {
  skip: process.platform !== "win32" || process.env.CMD_RIKER_WINDOWS_INTEGRATION !== "1",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cmd-riker-scheduler-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const starts = join(root, "starts.txt");
  const fixture = join(root, "actor.cjs");
  await writeFile(
    fixture,
    `require("node:fs").appendFileSync(${JSON.stringify(starts)}, "start\\n"); setTimeout(() => {}, 2000);\n`,
  );
  const whoami = execFileSync(
    "whoami.exe",
    ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  const userSid = /,"(S-[0-9-]+)"$/.exec(whoami)?.[1];
  assert(userSid, "Windows integration requires the current user SID.");
  const supervision = createWindowsSupervision({
    taskName: `\\CMD Riker\\Integration ${randomUUID()}`,
    currentUserId: userSid,
    executable: process.execPath,
    arguments: `"${fixture}"`,
    policy: { restartCount: 1, restartIntervalMinutes: 1 },
  });
  t.after(() => supervision.unregister().catch(() => {}));

  await supervision.register();
  await supervision.verify();
  await supervision.start();
  await supervision.start();
  const deadline = Date.now() + 5_000;
  let startText: string | undefined;
  while (Date.now() < deadline) {
    startText = await readFile(starts, "utf8").catch(() => undefined);
    if (startText) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(startText?.trim().split(/\r?\n/).length, 1);
  await supervision.stop();
  await supervision.unregister();
});
